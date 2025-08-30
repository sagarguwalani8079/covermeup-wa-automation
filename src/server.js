// src/server.js

// Safe optional dotenv load (works locally; won't crash in prod if not present)
try { require('dotenv').config(); } catch (e) {}

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const bodyParser = require('body-parser');
const store = require('./store');

const app = express();

const {
  PORT = 3000,

  // Shopify
  SHOPIFY_WEBHOOK_SECRET,

  // WhatsApp Cloud API
  WA_TOKEN,
  WA_PHONE_ID,
  WA_GRAPH_VERSION = 'v20.0',
  WA_TEMPLATE_LANG = 'en_US', // default to en_US to avoid translation errors
  WHATSAPP_VERIFY_TOKEN,

  // Templates
  ORDER_CONFIRMATION_TEMPLATE = 'order_confirmation',          // prepaid flow (5 params)
  COD_CONFIRM_TEMPLATE = 'cod_confirm_and_summary_v1',         // COD flow (5 params, your new combined template)
  FALLBACK_TEMPLATE = 'hello_world',

  // Brand & formatting
  BRAND_NAME = 'CoverMeUp',
  DEFAULT_COUNTRY_CODE = '91'
} = process.env;

/* ------------------------ Express setup ------------------------ */

// Shopify requires the exact raw body for HMAC verification:
app.use('/webhooks/shopify', bodyParser.raw({ type: 'application/json' }));

// Everything else may use JSON
app.use(bodyParser.json());

app.get('/health', (req, res) => res.json({ ok: true, dbReady: !!store.ready }));

/* -------------------- Helpers & utilities --------------------- */

function verifyShopifyHmac(req) {
  const signature = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET || '')
    .update(req.body) // NOTE: this is the raw Buffer because of bodyParser.raw above
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  // India: accept 10-digit and add country code
  if (digits.length === 10) return `${DEFAULT_COUNTRY_CODE}${digits}`;
  if (digits.startsWith('0') && digits.length === 11) return `${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`;
  return digits;
}

/** Determine if an order is COD */
function isCOD(order) {
  const gateways = new Set(
    (order?.payment_gateway_names || [])
      .concat(order?.gateway ? [order.gateway] : [])
      .map(s => (s || '').toString().toLowerCase())
  );

  const hasCODGateway =
    gateways.has('cod') ||
    gateways.has('cash on delivery') ||
    gateways.has('cash_on_delivery');

  // Shopify usually sets financial_status = 'pending' for COD
  const pending = (order?.financial_status || '').toLowerCase() === 'pending';

  return hasCODGateway || pending;
}

/** Send a WhatsApp template with language fallback */
async function sendTemplate({ to, template, components }) {
  const langs = Array.from(new Set([WA_TEMPLATE_LANG, 'en_US', 'en'].filter(Boolean)));
  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_ID}/messages`;
  let lastErr = null;

  for (const lang of langs) {
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

    try {
      console.log('[WA SEND]', JSON.stringify({ to, template, components }, null, 2));
      await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }
      });
      return { ok: true };
    } catch (e) {
      const err = e?.response?.data || e?.message || e;
      console.error(`[WA SEND ERROR - ${template}]`, err);
      lastErr = err;

      // If template name missing for this translation, try next language
      const code = e?.response?.data?.error?.code;
      const details = e?.response?.data?.error?.error_data?.details || '';
      if (code === 132001 && /does not exist/i.test(details)) continue;

      // If parameter mismatch or other fatal error, don't keep looping
      break;
    }
  }

  // attempt 1 tiny fallback template without params if provided
  if (FALLBACK_TEMPLATE) {
    try {
      console.log('[WA SEND]', JSON.stringify({ to, template: FALLBACK_TEMPLATE }, null, 2));
      await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: { name: FALLBACK_TEMPLATE, language: { code: WA_TEMPLATE_LANG || 'en_US' } }
        },
        { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      return { ok: true, fallback: true };
    } catch (e) {
      console.error('[WA SEND FALLBACK ERROR]', e?.response?.data || e?.message || e);
    }
  }

  return { ok: false, error: lastErr };
}

/* -------------------- WhatsApp Webhook (verify) -------------------- */

app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
});

/* -------------------- WhatsApp Webhook (inbound) ------------------- */

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

      if (yes) await store.updateLatestOrderByPhone(from, { status: 'cod_confirmed', lastReply: body });
      else if (no) await store.updateLatestOrderByPhone(from, { status: 'cod_rejected',  lastReply: body });
      else await store.updateLatestOrderByPhone(from, { lastReply: body });
    }
    res.send('ok');
  } catch (e) {
    console.error('WA inbound error:', e?.message || e);
    res.send('err');
  }
});

/* -------------------- Shopify: Orders Create ----------------------- */

app.post('/webhooks/shopify/orders-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');
  if (!store.ready) return res.status(503).send('DB not ready');

  const o = JSON.parse(req.body.toString('utf8'));

  const to = normalizePhone(o.phone || o.customer?.phone || o.shipping_address?.phone);
  if (!to) return res.send('No phone');

  const name    = o?.shipping_address?.name || o?.customer?.first_name || 'there';
  const orderId = o.name || String(o.id);
  const total   = `₹${(Number(o.total_price) || 0).toFixed(2)}`;
  const items   = (o.line_items || [])
    .map(li => `${li.title} x${li.quantity}`)
    .join(', ')
    .slice(0, 900);

  // persist order
  await store.addOrder({
    id: o.id,
    orderId,
    phone: to,
    name,
    total,
    items,
    status: isCOD(o) ? 'cod_pending' : 'prepaid'
  });

  // Decide template & parameter order
  let templateName, components;

  if (isCOD(o)) {
    // Your new combined COD template: 5 params
    // 1: Customer name, 2: Brand name, 3: Order ID, 4: Total, 5: Items list
    templateName = COD_CONFIRM_TEMPLATE;
    components = [{
      type: 'body',
      parameters: [
        { type: 'text', text: name },
        { type: 'text', text: BRAND_NAME },
        { type: 'text', text: orderId },
        { type: 'text', text: total },
        { type: 'text', text: items }
      ]
    }];
  } else {
    // Prepaid: keep your 5-param order_confirmation
    // 1: Customer name, 2: Order ID, 3: Brand name, 4: Total, 5: Items list
    templateName = ORDER_CONFIRMATION_TEMPLATE;
    components = [{
      type: 'body',
      parameters: [
        { type: 'text', text: name },
        { type: 'text', text: orderId },
        { type: 'text', text: BRAND_NAME },
        { type: 'text', text: total },
        { type: 'text', text: items }
      ]
    }];
  }

  // Fire WhatsApp
  const result = await sendTemplate({ to, template: templateName, components });

  // Non-blocking: we already stored the order
  if (!result.ok) {
    console.error('Failed to send WA template:', result.error);
  }

  res.send('ok');
});

/* ---------------------------- Start ------------------------------- */

app.listen(PORT, () =>
  console.log(`Notifier (combined COD) listening on :${PORT}`)
);
