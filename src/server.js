// src/server.js

// Safe optional dotenv load: won't crash in prod if dotenv isn't bundled
try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const bodyParser = require('body-parser');
const store   = require('./store');

const app = express();

const {
  PORT = 3000,

  // Shopify
  SHOPIFY_WEBHOOK_SECRET,

  // WhatsApp Business Platform
  WA_TOKEN,
  WA_PHONE_ID,
  WA_GRAPH_VERSION = 'v20.0',
  WA_TEMPLATE_LANG = 'en_US',

  // Templates
  ORDER_CONFIRMATION_TEMPLATE = 'order_confirmation', // expects 5 vars
  ORDER_SHIPPED_TEMPLATE      = 'order_update',
  FALLBACK_TEMPLATE           = 'hello_world',

  // Misc
  WHATSAPP_VERIFY_TOKEN,
  BRAND_NAME = 'CoverMeUp',
  DEFAULT_COUNTRY_CODE = '91',

  // Admin broadcast
  BROADCAST_KEY,                  // required for /admin/broadcast
  DEFAULT_BROADCAST_TEMPLATE = 'offer_blast_v1', // change to your approved template
} = process.env;

// --- Middleware --------------------------------------------------------------
app.use('/webhooks/shopify', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

// Simple health
app.get('/health', (req, res) => res.json({ ok: true }));

// --- WhatsApp Webhook Verify -------------------------------------------------
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
});

// --- WhatsApp Inbound --------------------------------------------------------
app.post('/webhooks/whatsapp', async (req, res) => {
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages || [];
    for (const m of messages) {
      const from = m.from;
      let body = '';
      if (m.text?.body)   body = m.text.body.trim();
      if (m.button?.text) body = m.button.text.trim();

      await store.addMessage({ from, body, type: m.type, id: m.id });

      const yes = /^(yes|y|confirm|ok|okay|confirmed)$/i.test(body);
      const no  = /^(no|n|cancel|reject|stop|unsubscribe)$/i.test(body);

      if (yes)      await store.updateLatestOrderByPhone(from, { status: 'confirmed', lastReply: body });
      else if (no)  await store.updateLatestOrderByPhone(from, { status: 'rejected',  lastReply: body });
      else          await store.updateLatestOrderByPhone(from, { lastReply: body });
    }
    res.send('ok');
  } catch (e) {
    console.error('WA inbound error:', e?.message || e);
    res.send('err');
  }
});

// --- Helpers -----------------------------------------------------------------
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

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `${DEFAULT_COUNTRY_CODE}${digits}`;
  if (digits.startsWith('0') && digits.length === 11) return `${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`;
  return digits;
}

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
        template: { name: template, language: { code: lang } }
      };
      if (parameters?.length) {
        payload.template.components = [{ type: 'body', parameters }];
      }
      console.log('[WA SEND Template]', { template, lang, to });
      await axios.post(url, payload, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
      return;
    } catch (e) {
      const data = e?.response?.data;
      const details = data?.error?.error_data?.details || '';
      const code = data?.error?.code;
      console.error('[WA SEND ERROR]', { langTried: lang, code, details: details || data || e?.message });
      // Retry other languages only when template missing in that language
      if (code === 132001 && /does not exist/i.test(details || '')) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('All language attempts failed');
}

function makeParams(arr) {
  // Turn an array of strings into WA parameter objects
  return arr.filter(v => v != null && v !== '')
    .map(v => ({ type: 'text', text: String(v) }));
}

// --- Shopify: Orders Create -> Confirmation ----------------------------------
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
    // Your template expects 5 variables (based on your errors earlier)
    await sendTemplateWithFallback({
      to,
      template: ORDER_CONFIRMATION_TEMPLATE,
      parameters: makeParams([name, orderId, BRAND_NAME, total, items])
    });
  } catch (e) {
    console.error('[WA SEND FALLBACK] Failed:', e?.response?.data || e.message);
  }

  res.send('ok');
});

// --- Shopify: Fulfillment Create -> Shipped Update ---------------------------
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
      parameters: makeParams([name, orderId, BRAND_NAME])
    });
  } catch (e) {
    console.error('[WA SEND FAIL]', e?.response?.data || e.message);
  }

  res.send('ok');
});

// --- Admin: Broadcast (dry-run friendly) -------------------------------------
// Example dry run:
// /admin/broadcast?key=YOUR_KEY&template=offer_blast_v1&dry=1&limit=5&p1=Hi&p2=20%25%20OFF
// Target explicit phones (comma-separated):
// /admin/broadcast?key=YOUR_KEY&to=91999...,91888...&template=offer_blast_v1&p1=Hi
app.get('/admin/broadcast', async (req, res) => {
  try {
    if (!BROADCAST_KEY || req.query.key !== BROADCAST_KEY) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // Ensure DB is ready (fixes "DB not ready" from earlier)
    let db;
    try {
      db = await store.getDb();
    } catch (e) {
      console.error('broadcast DB wait error:', e?.message || e);
      return res.status(500).json({ ok: false, error: `DB init failed: ${e?.message || e}` });
    }

    const template = (req.query.template || DEFAULT_BROADCAST_TEMPLATE).trim();
    const dry = req.query.dry == '1' || req.query.dry === 'true';
    const limit = Math.max(0, Math.min(1000, parseInt(req.query.limit || '100', 10)));

    // Collect params p1..p10 for template body variables
    const p = [];
    for (let i = 1; i <= 10; i++) {
      const v = req.query[`p${i}`];
      if (v != null) p.push(v);
    }
    const parameters = makeParams(p);

    // Audience: explicit `to` list OR distinct phones from recent orders
    let audience = [];
    if (req.query.to) {
      audience = String(req.query.to)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } else {
      const Orders = db.collection('orders');
      const Unsubs = db.collection('unsubscribes');
      const unsubPhones = new Set(await Unsubs.distinct('phone'));
      const phones = await Orders.distinct('phone');
      audience = phones.filter(ph => ph && !unsubPhones.has(ph));
    }

    if (limit) audience = audience.slice(0, limit);

    if (dry) {
      return res.json({
        ok: true,
        dry: true,
        template,
        parametersPreview: p,
        audienceCount: audience.length,
        sample: audience.slice(0, Math.min(audience.length, 20)),
      });
    }

    // Send
    let sent = 0, failed = 0;
    const results = [];
    for (const to of audience) {
      try {
        await sendTemplateWithFallback({ to, template, parameters });
        sent++;
        results.push({ to, ok: true });
      } catch (e) {
        failed++;
        results.push({ to, ok: false, error: e?.response?.data || e?.message });
      }
    }

    res.json({ ok: true, template, sent, failed, total: audience.length, results });

  } catch (err) {
    console.error('broadcast fatal:', err);
    res.status(500).json({ ok: false, error: err?.message || 'server error' });
  }
});

// Optional: quick unsubscribe endpoint (e.g., put a link in messages)
app.get('/admin/unsubscribe', async (req, res) => {
  try {
    let db;
    try {
      db = await store.getDb();
    } catch (e) {
      return res.status(500).json({ ok: false, error: `DB init failed: ${e?.message || e}` });
    }
    const phone = req.query.phone && String(req.query.phone).replace(/\D/g, '');
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });
    await db.collection('unsubscribes').updateOne(
      { phone },
      { $set: { phone, createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true, message: 'Unsubscribed' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'server error' });
  }
});

// --- Start -------------------------------------------------------------------
app.listen(PORT, () => console.log(`Notifier v5.7.2 listening on :${PORT}`));
