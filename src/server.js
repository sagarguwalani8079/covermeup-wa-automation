// src/server.js

// Safe optional dotenv for local dev
try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const bodyParser = require('body-parser');
const store = require('./store');

const app = express();

/* ========= ENV ========= */
const {
  PORT = 3000,

  // Shopify
  SHOPIFY_WEBHOOK_SECRET,

  // WhatsApp Cloud
  WA_TOKEN,
  WA_PHONE_ID,
  WA_GRAPH_VERSION = 'v20.0',
  WA_TEMPLATE_LANG = 'en_US', // IMPORTANT: Meta expects en_US, not "en"

  // Template names (configure in Render → Environment)
  PREPAID_TEMPLATE = 'order_confirmation',
  SHIPPED_TEMPLATE = 'order_update',
  FALLBACK_TEMPLATE = 'cmu_fallback_0',
  COD_TEMPLATE = 'cod_confirm_v2', // <- set this in Render

  // Branding / misc
  BRAND_NAME = 'CoverMeUp',
  DEFAULT_COUNTRY_CODE = '91',

  // Simple admin key for /admin endpoints
  ADMIN_KEY = 'covermeup123',
} = process.env;

/* ========= MIDDLEWARE ========= */
app.use('/webhooks/shopify', bodyParser.raw({ type: 'application/json' })); // HMAC requires raw
app.use(bodyParser.json());

app.get('/health', (_, res) => res.json({ ok: true }));

/* ========= HELPERS ========= */
function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `${DEFAULT_COUNTRY_CODE}${d}`;
  if (d.startsWith('0') && d.length === 11) return `${DEFAULT_COUNTRY_CODE}${d.slice(1)}`;
  return d;
}

function verifyShopifyHmac(req) {
  try {
    const h = req.get('X-Shopify-Hmac-Sha256') || '';
    const digest = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET || '')
      .update(req.body)
      .digest('base64');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(h));
  } catch {
    return false;
  }
}

async function waSendTemplate({ to, template, bodyParams = [], headerImageUrl }) {
  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template,
      language: { code: WA_TEMPLATE_LANG }, // e.g., en_US
      components: []
    }
  };

  if (headerImageUrl) {
    payload.template.components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: headerImageUrl } }]
    });
  }

  if (bodyParams.length) {
    payload.template.components.push({
      type: 'body',
      parameters: bodyParams.map(t => ({ type: 'text', text: String(t) }))
    });
  }

  try {
    console.log('[WA SEND]', JSON.stringify({ to, template, components: payload.template.components }, null, 2));
    await axios.post(url, payload, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
    return { ok: true };
  } catch (e) {
    const err = e?.response?.data || e?.message || e;
    console.error(`[WA SEND ERROR - ${template}]`, err);
    return { ok: false, error: err };
  }
}

async function waSendWithFallback(opts) {
  const r = await waSendTemplate(opts);
  if (r.ok) return r;

  // If template missing in selected language, try FALLBACK_TEMPLATE if set
  const details = r?.error?.error_data?.details || '';
  if (String(r?.error?.code) === '132001' || /does not exist/i.test(details)) {
    if (FALLBACK_TEMPLATE) {
      console.log('[WA SEND] trying fallback template:', FALLBACK_TEMPLATE);
      return waSendTemplate({ to: opts.to, template: FALLBACK_TEMPLATE });
    }
  }
  return r;
}

/* ========= WHATSAPP VERIFY (GET) ========= */
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
});

/* ========= WHATSAPP INBOUND (POST) ========= */
app.post('/webhooks/whatsapp', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const messages = changes?.messages || [];
    const contacts = changes?.contacts || [];

    for (const m of messages) {
      const from = m.from;
      let bodyText = '';
      let type = m.type;

      // Text
      if (m.text?.body) bodyText = m.text.body.trim();

      // Quick reply / button
      // Cloud API sends interactive replies like:
      // m.type === 'interactive' && m.interactive.button_reply: { id, title }
      // m.type === 'button' && m.button: { text } (older payloads)
      let payload = null;
      if (m.type === 'interactive' && m.interactive?.button_reply) {
        bodyText = m.interactive.button_reply.title;
        payload = m.interactive.button_reply.id; // <-- YOUR PAYLOAD (from template)
      } else if (m.button?.text) {
        bodyText = m.button.text.trim();
      }

      await store.addMessage({
        from,
        body: bodyText,
        type,
        id: m.id,
        payload
      });

      // Optional: auto-tag the latest order with the reply
      if (bodyText) {
        await store.updateLatestOrderByPhone(from, { lastReply: bodyText, lastPayload: payload || null });
      }

      // (Optional) Act on COD confirm/cancel payloads
      if (payload === 'COD_CONFIRM') {
        await store.updateLatestOrderByPhone(from, { status: 'cod_confirmed' });
      } else if (payload === 'COD_CANCEL') {
        await store.updateLatestOrderByPhone(from, { status: 'cod_cancelled' });
      }
    }

    res.send('ok');
  } catch (e) {
    console.error('WA inbound error:', e?.message || e);
    res.send('err');
  }
});

/* ========= SHOPIFY WEBHOOKS ========= */
// Orders create → decide template (COD vs prepaid), send message
app.post('/webhooks/shopify/orders-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');

  const o = JSON.parse(req.body.toString('utf8'));

  const phone = normalizePhone(o.phone || o.customer?.phone || o.shipping_address?.phone);
  if (!phone) return res.send('No phone');

  const name = o?.shipping_address?.name || o?.customer?.first_name || 'there';
  const orderId = o.name || String(o.id);
  const total = `₹${(Number(o.total_price) || 0).toFixed(2)}`;
  const items = (o.line_items || []).map(li => `${li.title} x${li.quantity}`).join(', ').slice(0, 900);

  // Persist order
  await store.addOrder({
    id: o.id,
    orderId,
    phone,
    name,
    total,
    items,
    status: 'pending',
    cod: isCOD(o)
  });

  // pick template
  const templateToUse = isCOD(o) ? COD_TEMPLATE : PREPAID_TEMPLATE;

  // Body params: adjust to your template variables
  // Common 5 placeholders: {{1}} Name, {{2}} OrderId, {{3}} Brand, {{4}} Total, {{5}} Items
  await waSendWithFallback({
    to: phone,
    template: templateToUse,
    bodyParams: [name, orderId, BRAND_NAME, total, items]
  });

  res.send('ok');
});

// Fulfillment → shipped update
app.post('/webhooks/shopify/fulfillments-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');

  const f = JSON.parse(req.body.toString('utf8'));
  const phone = normalizePhone(f?.shipping_address?.phone);
  if (!phone) return res.send('No phone');

  const name = f?.shipping_address?.name || 'there';
  const orderId = f.name || String(f.order_id || '');

  await waSendWithFallback({
    to: phone,
    template: SHIPPED_TEMPLATE,
    bodyParams: [name, orderId, BRAND_NAME]
  });

  res.send('ok');
});

/* ========= ADMIN / TEST UTILITIES ========= */
// Quick broadcast/test without Shopify. Example:
// /admin/broadcast?key=covermeup123&template=cod_confirm_v2&to=91978...&p1=Hi&p2=Order%20#123&img=https://...
app.get('/admin/broadcast', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'forbidden' });

  const to = normalizePhone(req.query.to || '');
  const template = req.query.template || COD_TEMPLATE;
  const bodyParams = [];
  for (let i = 1; i <= 10; i++) {
    const v = req.query[`p${i}`];
    if (v != null) bodyParams.push(String(v));
  }
  const headerImageUrl = req.query.img;

  const dry = String(req.query.dry || '') === '1';
  if (dry) {
    return res.json({
      ok: true,
      dry: true,
      template,
      parametersPreview: bodyParams,
      headerImageUrl,
      to
    });
  }

  const r = await waSendWithFallback({ to, template, bodyParams, headerImageUrl });
  return res.json({ ok: r.ok, template, ...(!r.ok ? { error: r.error } : {}) });
});

/* ========= UTILS ========= */
function isCOD(order) {
  // Robust checks across Shopify payloads
  const gw = (order.gateway || '').toLowerCase();
  const method = (order.processing_method || '').toLowerCase();
  const paymentNames = (order.payment_gateway_names || []).map(s => (s || '').toLowerCase());

  return (
    gw.includes('cod') ||
    gw.includes('cash on delivery') ||
    method.includes('manual') && paymentNames.some(s => s.includes('cod') || s.includes('cash on delivery')) ||
    paymentNames.some(s => s.includes('cod') || s.includes('cash on delivery'))
  );
}

/* ========= START ========= */
app.listen(PORT, () => {
  console.log(`Notifier v5.7.2 listening on :${PORT}`);
});
