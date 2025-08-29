// src/server.js
// Safe dotenv load (won't crash on Render if dotenv isn't installed)
try { require('dotenv').config(); } catch (_) {}

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
  WA_TEMPLATE_LANG = 'en_US',

  // Templates
  ORDER_CONFIRMATION_TEMPLATE = 'order_confirmation',
  ORDER_SHIPPED_TEMPLATE = 'order_update',

  // Broadcasts / generic
  FALLBACK_TEMPLATE = 'hello_world',

  // Verify
  WHATSAPP_VERIFY_TOKEN,

  // Business copy
  BRAND_NAME = 'CoverMeUp',
  DEFAULT_COUNTRY_CODE = '91'
} = process.env;

/* -----------------------------------------------------------------------------
 * Express config
 * ---------------------------------------------------------------------------*/
app.use('/webhooks/shopify', bodyParser.raw({ type: 'application/json' }));
app.get('/health', (_, res) => res.json({ ok: true }));
app.use(bodyParser.json());

/* -----------------------------------------------------------------------------
 * Whatsapp verification (GET)
 * ---------------------------------------------------------------------------*/
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
});

/* -----------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------*/
function verifyShopifyHmac(req) {
  const sig = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET || '')
    .update(req.body)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
  } catch {
    return false;
  }
}

function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  // Indian 10-digit → prefix default country code
  if (d.length === 10) return `${DEFAULT_COUNTRY_CODE}${d}`;
  // Leading 0 + 10-digit → strip 0 and prefix country
  if (d.startsWith('0') && d.length === 11) return `${DEFAULT_COUNTRY_CODE}${d.slice(1)}`;
  return d; // already has country code, etc.
}

async function sendTemplate({ to, template, components }) {
  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template,
      language: { code: WA_TEMPLATE_LANG },
      components
    }
  };

  console.log('[WA SEND]', JSON.stringify({ to, template, components }, null, 2));

  const r = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` }
  });
  return r.data;
}

/* -----------------------------------------------------------------------------
 * WhatsApp inbound webhook (POST)
 *  – Handles Quick Reply button text (no payload)
 *  – COD buttons: "Confirm COD" / "Cancel Order"
 *  – Also supports plain yes/no confirmations
 * ---------------------------------------------------------------------------*/
app.post('/webhooks/whatsapp', async (req, res) => {
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages || [];

    for (const m of messages) {
      const from = m.from;
      // prefer button text if present, else body text
      const incomingText = (m.button?.text || m.text?.body || '').trim();
      const lower = incomingText.toLowerCase();

      // Persist inbound message for dashboard
      await store.addMessage({
        from,
        type: m.type,
        id: m.id,
        body: incomingText
      });

      // --- COD flow via Quick Reply button text-----------------------------
      if (/^confirm cod$/i.test(incomingText)) {
        await store.updateLatestOrderByPhone(from, {
          status: 'confirmed',
          lastReply: 'Confirm COD'
        });
        console.log('[INBOUND] COD confirmed by user', from);
        continue;
      }

      if (/^cancel order$/i.test(incomingText)) {
        await store.updateLatestOrderByPhone(from, {
          status: 'rejected',
          lastReply: 'Cancel Order'
        });
        console.log('[INBOUND] COD cancelled by user', from);
        continue;
      }

      // --- Generic yes / no handling (fallback for text replies) -----------
      const yes = /^(yes|y|confirm|ok|okay|confirmed)$/i.test(incomingText);
      const no = /^(no|n|cancel|reject|stop)$/i.test(incomingText);

      if (yes) {
        await store.updateLatestOrderByPhone(from, {
          status: 'confirmed',
          lastReply: incomingText
        });
      } else if (no) {
        await store.updateLatestOrderByPhone(from, {
          status: 'rejected',
          lastReply: incomingText
        });
      } else {
        await store.updateLatestOrderByPhone(from, { lastReply: incomingText });
      }
    }

    res.send('ok');
  } catch (e) {
    console.error('WA inbound error:', e?.response?.data || e?.message || e);
    res.status(200).send('err'); // keep 200 for Meta delivery
  }
});

/* -----------------------------------------------------------------------------
 * Shopify order create → send initial order template
 * ---------------------------------------------------------------------------*/
app.post('/webhooks/shopify/orders-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');

  const o = JSON.parse(req.body.toString('utf8'));

  const to = normalizePhone(o.phone || o.customer?.phone || o.shipping_address?.phone);
  if (!to) return res.send('No phone');

  const name = o?.shipping_address?.name || o?.customer?.first_name || 'there';
  const orderId = o.name || String(o.id);
  const total = `₹${(Number(o.total_price) || 0).toFixed(2)}`;
  const items = (o.line_items || [])
    .map(li => `${li.title} x${li.quantity}`)
    .join(', ')
    .slice(0, 900);

  // Save order
  await store.addOrder({
    id: o.id,
    orderId,
    phone: to,
    name,
    total,
    items,
    status: 'pending'
  });

  // Send order confirmation template (5 params version)
  try {
    await sendTemplate({
      to,
      template: ORDER_CONFIRMATION_TEMPLATE,
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
  } catch (e) {
    console.error('[WA SEND ERROR - order_confirmation]', e?.response?.data || e.message);
    // Try a simple fallback template (no params) so user still gets something
    try {
      await sendTemplate({ to, template: FALLBACK_TEMPLATE });
      console.log('[WA SEND FALLBACK] Fallback sent successfully');
    } catch (e2) {
      console.error('[WA SEND FALLBACK ERROR]', e2?.response?.data || e2.message);
    }
  }

  res.send('ok');
});

/* -----------------------------------------------------------------------------
 * Shopify fulfillment create → shipped template
 * ---------------------------------------------------------------------------*/
app.post('/webhooks/shopify/fulfillments-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');

  const f = JSON.parse(req.body.toString('utf8'));
  const to = normalizePhone(f?.shipping_address?.phone);
  if (!to) return res.send('No phone');

  const name = f?.shipping_address?.name || 'there';
  const orderId = f.name || String(f.order_id || '');

  try {
    await sendTemplate({
      to,
      template: ORDER_SHIPPED_TEMPLATE,
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: name },
            { type: 'text', text: orderId },
            { type: 'text', text: BRAND_NAME }
          ]
        }
      ]
    });
  } catch (e) {
    console.error('[WA SEND ERROR - order_update]', e?.response?.data || e.message);
  }

  res.send('ok');
});

/* -----------------------------------------------------------------------------
 * Start server
 * ---------------------------------------------------------------------------*/
app.listen(PORT, () => {
  console.log(`Notifier v5.7.2 listening on :${PORT}`);
});
