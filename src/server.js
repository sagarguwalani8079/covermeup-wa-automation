// src/server.js
try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');

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
  COD_CONFIRM_TEMPLATE = 'cod_confirm_v1', // <-- create this in Meta

  // General
  BRAND_NAME = 'CoverMeUp',
  DEFAULT_COUNTRY_CODE = '91',

  // Simple admin key for test endpoints
  ADMIN_KEY = 'covermeup123',
} = process.env;

app.use('/webhooks/shopify', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- WhatsApp helpers ----------

const wa = axios.create({
  baseURL: `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_ID}`,
  headers: { Authorization: `Bearer ${WA_TOKEN}` },
});

async function sendTemplate({ to, name, headerImage, bodyParams = [] }) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: WA_TEMPLATE_LANG },
      components: [],
    },
  };

  if (bodyParams.length) {
    payload.template.components.push({
      type: 'body',
      parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })),
    });
  }

  if (headerImage) {
    payload.template.components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: headerImage } }],
    });
  }

  console.log('[WA SEND]', JSON.stringify({
    to, template: name, headerImage, bodyParams,
  }, null, 2));

  await wa.post('/messages', payload);
}

function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `${DEFAULT_COUNTRY_CODE}${d}`;
  if (d.startsWith('0') && d.length === 11) return `${DEFAULT_COUNTRY_CODE}${d.slice(1)}`;
  return d;
}

function verifyShopifyHmac(req) {
  const h = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET || '')
    .update(req.body)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(h));
  } catch {
    return false;
  }
}

// ---------- WhatsApp Webhook (incoming) ----------

app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
});

app.post('/webhooks/whatsapp', async (req, res) => {
  try {
    const changes = req.body?.entry?.[0]?.changes || [];
    for (const ch of changes) {
      const msgs = ch?.value?.messages || [];
      for (const m of msgs) {
        const from = m.from;
        let body = '';
        let payload = '';

        if (m.button?.text) body = m.button.text.trim();
        if (m.button?.payload) payload = m.button.payload.trim();
        if (m.text?.body) body = m.text.body.trim();

        await store.addMessage({
          from, body, payload, type: m.type, id: m.id,
        });

        // COD confirm via template quick-reply buttons
        if (payload === 'cod_yes' || /^(yes|y|confirm|ok|okay)$/i.test(body)) {
          const ord = await store.findLatestPendingCODByPhone(from);
          if (ord) {
            await store.setOrderStatusById(ord.orderId, { status: 'confirmed' });
          } else {
            await store.updateLatestOrderByPhone(from, { status: 'confirmed', lastReply: body || payload });
          }
          continue;
        }

        if (payload === 'cod_no' || /^(no|n|cancel|reject|stop)$/i.test(body)) {
          const ord = await store.findLatestPendingCODByPhone(from);
          if (ord) {
            await store.setOrderStatusById(ord.orderId, { status: 'rejected' });
          } else {
            await store.updateLatestOrderByPhone(from, { status: 'rejected', lastReply: body || payload });
          }
          continue;
        }

        // Any other reply: attach as lastReply on the latest order
        await store.updateLatestOrderByPhone(from, { lastReply: body || payload });
      }
    }
    res.send('ok');
  } catch (e) {
    console.error('WA inbound error:', e?.response?.data || e);
    res.send('err');
  }
});

// ---------- Shopify Webhooks ----------

// Orders Create → send confirmation (COD-aware)
app.post('/webhooks/shopify/orders-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');

  const o = JSON.parse(req.body.toString('utf8'));

  // Collect phone
  const to = normalizePhone(
    o.phone || o.customer?.phone || o.shipping_address?.phone
  );
  if (!to) return res.send('No phone');

  // Detect COD
  const gateways = (o.payment_gateway_names || []).map(s => s.toLowerCase());
  const codLikely =
    gateways.some(g => /cod|cash on delivery|cash-on-delivery/.test(g)) ||
    /cod|cash/.test(String(o.gateway || '').toLowerCase()) ||
    (String(o.financial_status || '').toLowerCase() === 'pending' &&
     gateways.some(g => g.includes('cash')));

  const name = o?.shipping_address?.name || o?.customer?.first_name || 'there';
  const orderId = o.name || String(o.id);
  const total = `₹${(Number(o.total_price) || 0).toFixed(2)}`;
  const items = (o.line_items || [])
    .map(li => `${li.title} x${li.quantity}`)
    .join(', ')
    .slice(0, 900);

  // Persist
  await store.addOrder({
    orderId,
    shopifyId: o.id,
    phone: to,
    name,
    total,
    items,
    status: codLikely ? 'pending_cod' : 'pending',
    cod: !!codLikely,
  });

  try {
    if (codLikely) {
      // COD confirmation template (with quick reply buttons defined in the template)
      // Body variables we’ll pass: {{1}} = name, {{2}} = orderId, {{3}} = BRAND_NAME (optional)
      await sendTemplate({
        to,
        name: COD_CONFIRM_TEMPLATE,
        bodyParams: [name, orderId, BRAND_NAME],
      });
    } else {
      // Prepaid / captured → normal order confirmation template
      await sendTemplate({
        to,
        name: ORDER_CONFIRMATION_TEMPLATE,
        bodyParams: [name, orderId, BRAND_NAME, total, items],
      });
    }
  } catch (e) {
    console.error('[WA SEND ERROR]', e?.response?.data || e.message);
  }

  res.send('ok');
});

// Fulfillment Create → shipped notification
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
      name: ORDER_SHIPPED_TEMPLATE,
      bodyParams: [name, orderId, BRAND_NAME],
    });
  } catch (e) {
    console.error('[WA SEND FAIL]', e?.response?.data || e.message);
  }

  res.send('ok');
});

// ---------- Simple admin tools ----------

// Dry-run test of COD template to one number
app.get('/admin/test-cod', async (req, res) => {
  try {
    const { key, to, name = 'Friend', orderId = '#1234' } = req.query;
    if (key !== ADMIN_KEY) return res.status(403).json({ ok: false });

    await sendTemplate({
      to,
      name: COD_CONFIRM_TEMPLATE,
      bodyParams: [name, orderId, BRAND_NAME],
    });
    res.json({ ok: true, sent: to });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, async () => {
  try {
    await store.init();
  } catch (e) {
    console.error('❌ MongoDB connection failed:', e);
  }
  console.log(`Notifier v5.7.2 listening on :${PORT}`);
});
