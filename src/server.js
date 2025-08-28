// src/server.js
// WhatsApp + Shopify notifier with Mongo-backed dashboard

// Safe optional dotenv (works locally; no crash in Render)
try { require('dotenv').config(); } catch {}

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const bodyParser = require('body-parser');
const store = require('./store');

const app = express();

const {
  PORT = 3000,
  SHOPIFY_WEBHOOK_SECRET,
  WA_TOKEN,
  WA_PHONE_ID,
  WA_GRAPH_VERSION = 'v20.0',
  WA_TEMPLATE_LANG = 'en',
  ORDER_CONFIRMATION_TEMPLATE = 'order_confirmation',
  ORDER_SHIPPED_TEMPLATE = 'order_update',
  FALLBACK_TEMPLATE = 'hello_world',
  WHATSAPP_VERIFY_TOKEN,
  BRAND_NAME = 'CoverMeUp',
  DEFAULT_COUNTRY_CODE = '91',
} = process.env;

app.use('/webhooks/shopify', bodyParser.raw({ type: 'application/json' }));
app.get('/health', (req, res) => res.json({ ok: true, version: 'v5.7.2' }));
app.use(bodyParser.json());

// ---------- WhatsApp verification ----------
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
});

// ---------- Incoming WhatsApp messages ----------
app.post('/webhooks/whatsapp', async (req, res) => {
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages || [];
    for (const m of messages) {
      const from = m.from;
      let body = '';
      if (m.text?.body) body = m.text.body.trim();
      if (m.button?.text) body = m.button.text.trim();

      await store.addMessage({ from, body, type: m.type, id: m.id });

      const yes = /^(yes|y|confirm|ok|okay|confirmed)$/i.test(body);
      const no  = /^(no|n|cancel|reject|stop)$/i.test(body);

      if (yes) await store.updateLatestOrderByPhone(from, { status: 'confirmed', lastReply: body });
      else if (no) await store.updateLatestOrderByPhone(from, { status: 'rejected', lastReply: body });
      else await store.updateLatestOrderByPhone(from, { lastReply: body });
    }
    res.send('ok');
  } catch (e) {
    console.error('WA inbound error:', e?.message || e);
    res.send('err');
  }
});

// ---------- Shopify HMAC verify ----------
function verifyShopifyHmac(req) {
  const h = req.get('X-Shopify-Hmac-Sha256') || '';
  const d = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET || '')
    .update(req.body)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(d), Buffer.from(h));
  } catch {
    return false;
  }
}

// ---------- Phone normalizer ----------
function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `${DEFAULT_COUNTRY_CODE}${d}`;
  if (d.startsWith('0') && d.length === 11) return `${DEFAULT_COUNTRY_CODE}${d.slice(1)}`;
  return d;
}

// ---------- WhatsApp template sender with language fallback ----------
async function sendTemplateWithFallback({ to, template, parameters }) {
  const langs = Array.from(new Set([WA_TEMPLATE_LANG, 'en_US', 'en'].filter(Boolean)));
  let lastErr = null;
  for (const lang of langs) {
    try {
      const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_ID}/messages`;
      const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name: template, language: { code: lang } },
      };
      if (parameters?.length) {
        payload.template.components = [{ type: 'body', parameters }];
      }
      console.log('[WA SEND Template]', { template, lang, to });
      await axios.post(url, payload, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
      if (lang !== WA_TEMPLATE_LANG) console.log(`[WA RETRY] Succeeded with fallback language: ${lang}`);
      return;
    } catch (e) {
      const data = e?.response?.data;
      const details = data?.error?.error_data?.details || '';
      const code = data?.error?.code;
      console.error('[WA SEND ERROR]', { langTried: lang, code, details: details || data || e.message });
      if (code === 132001 && /translation/i.test(details || '')) {
        lastErr = e; continue;
      } else {
        throw e;
      }
    }
  }
  throw lastErr || new Error('All language attempts failed');
}

// ---------- Shopify: Orders Create -> send confirmation ----------
app.post('/webhooks/shopify/orders-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');

  const o = JSON.parse(req.body.toString('utf8'));
  const to = normalizePhone(o.phone || o.customer?.phone || o.shipping_address?.phone);
  if (!to) return res.send('No phone');

  const name = o?.shipping_address?.name || o?.customer?.first_name || 'there';
  const orderId = o.name || String(o.id);
  const total = `₹${(Number(o.total_price) || 0).toFixed(2)}`;
  const items = (o.line_items || []).map(li => `${li.title} x${li.quantity}`).join(', ').slice(0, 900);

  await store.addOrder({ id: o.id, orderId, phone: to, name, total, items, status: 'pending' });

  try {
    await sendTemplateWithFallback({
      to,
      template: ORDER_CONFIRMATION_TEMPLATE,
      parameters: [
        { type: 'text', text: name },
        { type: 'text', text: orderId },
        { type: 'text', text: BRAND_NAME },
        { type: 'text', text: total },
        { type: 'text', text: items },
      ],
    });
  } catch (e) {
    console.error('[WA SEND FALLBACK] Failed:', e?.response?.data || e.message);
  }

  res.send('ok');
});

// ---------- Shopify: Fulfillment Create -> shipped update ----------
app.post('/webhooks/shopify/fulfillments-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');

  const f = JSON.parse(req.body.toString('utf8'));
  const orderId = f.name || String(f.order_id || '');
  const to = normalizePhone(f?.shipping_address?.phone);
  if (!to) return res.send('No phone');

  const name = f?.shipping_address?.name || 'there';

  try {
    await sendTemplateWithFallback({
      to,
      template: ORDER_SHIPPED_TEMPLATE,
      parameters: [
        { type: 'text', text: name },
        { type: 'text', text: orderId },
        { type: 'text', text: BRAND_NAME },
      ],
    });
  } catch (e) {
    console.error('[WA SEND FAIL]', e?.response?.data || e.message);
  }

  res.send('ok');
});

// ---------- Simple HTML dashboard (Mongo-backed) ----------
function esc(s = '') {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

app.get('/dashboard', async (_req, res) => {
  try {
    const [orders, messages] = await Promise.all([
      store.getRecentOrders(50),
      store.getRecentMessages(50),
    ]);

    const ordersRows = orders.map(o => `
      <tr>
        <td>${esc(o.createdAt?.toISOString?.() || '')}</td>
        <td>${esc(o.orderId || '')}</td>
        <td>${esc(o.name || '')}</td>
        <td>${esc(o.phone || '')}</td>
        <td>${esc(o.total || '')}</td>
        <td class="items" title="${esc(o.items || '')}">${esc((o.items || '').slice(0, 120))}</td>
        <td>${esc(o.status || '')}</td>
        <td>${esc(o.lastReply || '')}</td>
      </tr>`).join('');

    const msgRows = messages.map(m => `
      <tr>
        <td>${esc(m.createdAt?.toISOString?.() || '')}</td>
        <td>${esc(m.from || '')}</td>
        <td>${esc(m.type || '')}</td>
        <td>${esc(m.body || '')}</td>
      </tr>`).join('');

    res.set('Content-Type', 'text/html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>CoverMeUp WhatsApp Dashboard</title>
  <style>
    body{font:14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin:24px;}
    h1{margin:0 0 8px;font-size:24px}
    small{opacity:.6}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
    table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
    th{background:#f8f8f8;text-align:left;position:sticky;top:0}
    .items{max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#eef;color:#334}
    .muted{color:#666}
  </style>
</head>
<body>
  <h1>CoverMeUp WhatsApp Dashboard <span class="pill">public</span></h1>
  <div class="muted">Updated: ${esc(new Date().toISOString())}</div>

  <div class="grid" style="margin-top:20px">
    <section>
      <h2>Recent orders (max 50)</h2>
      <div style="max-height:60vh;overflow:auto;border:1px solid #eee">
      <table>
        <thead>
          <tr>
            <th>Created</th><th>Order</th><th>Name</th><th>Phone</th>
            <th>Total</th><th>Items</th><th>Status</th><th>Last reply</th>
          </tr>
        </thead>
        <tbody>${ordersRows || ''}</tbody>
      </table>
      </div>
    </section>

    <section>
      <h2>Recent messages (max 50)</h2>
      <div style="max-height:60vh;overflow:auto;border:1px solid #eee">
      <table>
        <thead>
          <tr><th>Created</th><th>From</th><th>Type</th><th>Body</th></tr>
        </thead>
        <tbody>${msgRows || ''}</tbody>
      </table>
      </div>
    </section>
  </div>
</body>
</html>`);
  } catch (e) {
    console.error('Dashboard error:', e);
    res.status(500).send('Dashboard error');
  }
});

app.listen(PORT, () => console.log(`Notifier v5.7.2 listening on :${PORT}`));
