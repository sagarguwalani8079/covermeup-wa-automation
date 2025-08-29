// src/server.js
// ---------------------------------------------
// CoverMeUp WA notifier (Shopify + WhatsApp)
// - Detects COD vs Prepaid and sends different templates
// - Handles button replies ("Confirm COD", "Cancel Order")
// - Broadcast + health + WA verify hooks preserved
// ---------------------------------------------

// Safe optional dotenv load (won't crash in prod if absent)
try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const bodyParser = require('body-parser');
const store = require('./store');

const app = express();

/* ================== ENV ================== */
const {
  PORT = 3000,

  // Shopify
  SHOPIFY_WEBHOOK_SECRET = '',

  // WhatsApp Cloud API
  WA_TOKEN = '',
  WA_PHONE_ID = '',
  WA_GRAPH_VERSION = 'v20.0',
  WA_TEMPLATE_LANG = 'en_US',

  // Templates (override these in Render if names differ)
  PREPAID_TEMPLATE = 'order_confirmation_v1',
  COD_TEMPLATE = 'cod_confirmation_v1',
  FALLBACK_TEMPLATE = 'hello_world',

  // Brand & defaults
  BRAND_NAME = 'CoverMeUp',
  DEFAULT_COUNTRY_CODE = '91',

  // Admin key for /admin/broadcast, keep private
  ADMIN_KEY = 'covermeup123'
} = process.env;

/* ============ MIDDLEWARE ============ */
// Shopify webhooks must use raw body for HMAC verification
app.use('/webhooks/shopify', bodyParser.raw({ type: 'application/json' }));

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// General JSON
app.use(bodyParser.json());

/* ============ HELPERS ============ */
const WAGraph = axios.create({
  baseURL: `https://graph.facebook.com/${WA_GRAPH_VERSION}`,
  headers: { Authorization: `Bearer ${WA_TOKEN}` },
  timeout: 15000
});

function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `${DEFAULT_COUNTRY_CODE}${d}`;
  if (d.startsWith('0') && d.length === 11) return `${DEFAULT_COUNTRY_CODE}${d.slice(1)}`;
  return d;
}

function verifyShopifyHmac(req) {
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
    const digest = crypto
      .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
      .update(req.body) // raw buffer
      .digest('base64');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

/**
 * Send a template with language fallback order:
 *   WA_TEMPLATE_LANG -> en_US -> en
 * `components` is optional (array as per WA Cloud API)
 */
async function sendTemplate({ to, template, components }) {
  const langs = Array.from(new Set([WA_TEMPLATE_LANG, 'en_US', 'en'].filter(Boolean)));

  let lastErr = null;
  for (const lang of langs) {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: template,
          language: { code: lang }
        }
      };
      if (components && components.length) {
        payload.template.components = components;
      }

      console.log('[WA SEND]', JSON.stringify({ to, template, components }, null, 2));
      await WAGraph.post(`/${WA_PHONE_ID}/messages`, payload);
      return true;
    } catch (e) {
      const data = e?.response?.data;
      console.error(`[WA SEND ERROR - ${template}]`, data || e.message);
      // Try next language on "template name does not exist"
      const code = data?.error?.code;
      const details = data?.error?.error_data?.details || '';
      if (code === 132001 && /does not exist/i.test(details)) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;
  return false;
}

/* ============ WHATSAPP INBOUND (VERIFY + MESSAGES) ============ */
// Verification for WA webhook (if you wire Meta -> this endpoint)
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// Incoming WA messages (text / button)
app.post('/webhooks/whatsapp', async (req, res) => {
  try {
    const msgs = req.body?.entry?.[0]?.changes?.[0]?.value?.messages || [];
    for (const m of msgs) {
      const from = m.from;
      let body = '';

      // text message
      if (m.text?.body) body = String(m.text.body).trim();

      // old-style interactive buttons
      if (m.button?.text) body = String(m.button.text).trim();

      // new-style interactive payload
      if (m.type === 'interactive') {
        const ir = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
        if (ir) body = String(ir).trim();
      }

      await store.addMessage({ from, body, type: m.type, id: m.id });

      // Interpret COD confirmations
      const yes = /^(yes|y|confirm cod|confirm|ok|okay|confirmed)$/i.test(body);
      const no = /^(no|n|cancel cod|cancel|reject|stop)$/i.test(body);

      if (yes) {
        await store.updateLatestOrderByPhone(from, { status: 'confirmed', lastReply: body });
      } else if (no) {
        await store.updateLatestOrderByPhone(from, { status: 'cancelled', lastReply: body });
      } else {
        await store.updateLatestOrderByPhone(from, { lastReply: body });
      }
    }
    res.send('ok');
  } catch (e) {
    console.error('WA inbound error:', e?.message || e);
    res.send('err');
  }
});

/* ============ SHOPIFY WEBHOOKS ============ */
/**
 * orders/create (point your Shopify webhook here)
 * Chooses template based on payment method:
 *  - COD  -> COD_TEMPLATE (with buttons Confirm/Cancel)
 *  - Else -> PREPAID_TEMPLATE
 */
app.post('/webhooks/shopify/orders-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');

  const o = JSON.parse(req.body.toString('utf8'));

  // Phone
  const to =
    normalizePhone(o.phone) ||
    normalizePhone(o.customer?.phone) ||
    normalizePhone(o.shipping_address?.phone);

  if (!to) {
    console.log('[ORDERS CREATE] No phone on order', o.id);
    return res.send('No phone');
  }

  // Gather friendly values
  const name =
    o?.shipping_address?.name ||
    `${o?.customer?.first_name || ''} ${o?.customer?.last_name || ''}`.trim() ||
    'there';

  const orderId = o.name || String(o.id);
  const total = `₹${(Number(o.total_price) || 0).toFixed(2)}`;
  const items = (o.line_items || [])
    .map(li => `${li.title} x${li.quantity}`)
    .join(', ')
    .slice(0, 900);

  // Save in DB early
  await store.addOrder({
    id: o.id,
    orderId,
    phone: to,
    name,
    total,
    items,
    status: 'pending',
    createdAt: new Date()
  });

  // Detect COD
  const pg = (o.payment_gateway_names || []).map(s => (s || '').toLowerCase());
  const gatewayStr = String(o.gateway || '').toLowerCase();
  const isCOD =
    pg.some(s => s.includes('cash on delivery')) || gatewayStr.includes('cash on delivery');

  try {
    if (isCOD) {
      // COD confirmation with buttons (template must have 3 body variables: name, orderId, total)
      await sendTemplate({
        to,
        template: COD_TEMPLATE,
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: name },
              { type: 'text', text: orderId },
              { type: 'text', text: total }
            ]
          }
          // Buttons are defined in the template; no extra component is needed
        ]
      });
    } else {
      // Prepaid confirmation (template with 5 body variables: name, orderId, brand, total, items)
      await sendTemplate({
        to,
        template: PREPAID_TEMPLATE,
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: name },
              { type: 'text', text: orderId },
              { type: 'text', text: BRAND_NAME },
              { type: 'text', text: total },
              { type: 'text', text: items }
            ]
          }
        ]
      });
    }
  } catch (e) {
    console.error('[WA SEND after order] Failed:', e?.response?.data || e.message);
  }

  res.send('ok');
});

/* ============ ADMIN BROADCAST (optional) ============ */
/**
 * GET /admin/broadcast?key=...&template=...&to=919xxxx
 * Optional demo endpoint to send a single template.
 * You can also supply:
 *  - p1, p2, ... p10 -> body parameters
 *  - img -> header image URL (only for templates with image header)
 */
app.get('/admin/broadcast', async (req, res) => {
  try {
    if (req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'forbidden' });

    const to = normalizePhone(req.query.to);
    if (!to) return res.json({ ok: false, error: 'missing to' });

    const template = String(req.query.template || '').trim();
    if (!template) return res.json({ ok: false, error: 'missing template' });

    // Body parameters p1..p10
    const bodyParams = [];
    for (let i = 1; i <= 10; i++) {
      const k = `p${i}`;
      if (req.query[k] != null) bodyParams.push({ type: 'text', text: String(req.query[k]) });
    }

    // Optional header image
    const headerImage = req.query.img ? String(req.query.img) : null;

    const components = [];
    if (headerImage) {
      components.push({
        type: 'header',
        parameters: [{ type: 'image', image: { link: headerImage } }]
      });
    }
    if (bodyParams.length) {
      components.push({ type: 'body', parameters: bodyParams });
    }

    await sendTemplate({ to, template, components });
    return res.json({ ok: true, template, to });
  } catch (e) {
    console.error('broadcast error', e?.response?.data || e.message);
    res.json({ ok: false, error: e?.response?.data || e.message });
  }
});

/* ============ START ============ */
app.listen(PORT, () => {
  console.log(`Notifier v5.7.2 listening on :${PORT}`);
});
