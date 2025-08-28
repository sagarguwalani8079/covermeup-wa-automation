// Safe optional dotenv load (works locally, won't crash on Render)
try { require('dotenv').config(); } catch (e) {}

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const bodyParser = require('body-parser');
const store = require('./store'); // must export addOrder/addMessage/updateLatestOrderByPhone and getDb()

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

  // Broadcast
  BROADCAST_KEY,
  OFFER_TEMPLATE = 'offer_new_arrivals_v1',
  OFFER_TEXT = 'Flat 20% off. Shop now: https://covermeup.in/new'
} = process.env;

// --- Parsers -----------------------------------------------------------------
app.use('/webhooks/shopify', bodyParser.raw({ type: 'application/json' })); // HMAC requires raw body
app.use(bodyParser.json());

// --- Health ------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ ok: true }));

// --- WhatsApp Webhook Verification ------------------------------------------
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.status(403).send('Forbidden');
});

// --- Helpers -----------------------------------------------------------------
function verifyShopifyHmac(req) {
  const header = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET || '')
    .update(req.body)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(header));
  } catch {
    return false;
  }
}

function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `${DEFAULT_COUNTRY_CODE}${d}`;            // e.g., 98765... -> 91 + 10d
  if (d.startsWith('0') && d.length === 11) return `${DEFAULT_COUNTRY_CODE}${d.slice(1)}`;
  return d; // already has country code
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
        template: {
          name: template,
          language: { code: lang }
        }
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
      console.error('[WA SEND ERROR]', { langTried: lang, code, details });
      // Try next language if template-language mismatch
      if (code === 132001 && /does not exist/i.test(details || '')) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('All language attempts failed');
}

// Very light STOP/UNSUBSCRIBE detector
function isOptOutText(txt = '') {
  const t = String(txt).trim().toLowerCase();
  return /^(stop|unsubscribe|opt\s?out|cancel)$/i.test(t);
}

// YES / NO detector used for order confirmation threads
function isYesText(txt = '') {
  return /^(yes|y|confirm|ok|okay|confirmed)$/i.test(String(txt).trim());
}
function isNoText(txt = '') {
  return /^(no|n|cancel|reject|stop)$/i.test(String(txt).trim());
}

// --- WhatsApp Inbound --------------------------------------------------------
app.post('/webhooks/whatsapp', async (req, res) => {
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages || [];
    const db = store.getDb && store.getDb();
    const unsubCol = db && db.collection('unsubscribes');

    for (const m of messages) {
      const from = m.from;
      let body = '';
      if (m.text?.body) body = m.text.body.trim();
      if (m.button?.text) body = m.button.text.trim();

      // Save raw inbound
      await store.addMessage({ from, body, type: m.type, id: m.id });

      // Capture STOP / UNSUBSCRIBE into dedicated collection
      if (isOptOutText(body) && unsubCol) {
        await unsubCol.updateOne(
          { phone: from },
          { $set: { phone: from, at: new Date(), source: 'inbound' } },
          { upsert: true }
        );
      }

      // Update last reply on most recent order thread
      if (isYesText(body)) {
        await store.updateLatestOrderByPhone(from, { status: 'confirmed', lastReply: body });
      } else if (isNoText(body)) {
        await store.updateLatestOrderByPhone(from, { status: 'rejected', lastReply: body });
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

// --- Shopify: Orders Create --------------------------------------------------
app.post('/webhooks/shopify/orders-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');

  const order = JSON.parse(req.body.toString('utf8'));
  const to = normalizePhone(order.phone || order.customer?.phone || order.shipping_address?.phone);
  if (!to) return res.send('No phone');

  const name = order?.shipping_address?.name || order?.customer?.first_name || 'there';
  const orderId = order.name || String(order.id);
  const total = `₹${(Number(order.total_price) || 0).toFixed(2)}`;
  const items = (order.line_items || [])
    .map(li => `${li.title} x${li.quantity}`)
    .join(', ')
    .slice(0, 900);

  await store.addOrder({
    id: order.id,
    orderId,
    phone: to,
    name,
    total,
    items,
    status: 'pending'
  });

  try {
    await sendTemplateWithFallback({
      to,
      template: ORDER_CONFIRMATION_TEMPLATE,
      parameters: [
        { type: 'text', text: name },
        { type: 'text', text: orderId },
        { type: 'text', text: BRAND_NAME },
        { type: 'text', text: total },
        { type: 'text', text: items }
      ]
    });
  } catch (e) {
    console.error('[WA SEND FALLBACK] Failed:', e?.response?.data || e.message);
  }

  res.send('ok');
});

// --- Shopify: Fulfillment Create --------------------------------------------
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
        { type: 'text', text: BRAND_NAME }
      ]
    });
  } catch (e) {
    console.error('[WA SEND FAIL]', e?.response?.data || e.message);
  }

  res.send('ok');
});

// --- Admin Broadcast (Marketing) --------------------------------------------
// GET /admin/broadcast?key=...&dry=1&limit=20&template=...&text=...
app.get('/admin/broadcast', async (req, res) => {
  try {
    if (!BROADCAST_KEY || req.query.key !== BROADCAST_KEY) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const db = store.getDb && store.getDb();
    if (!db) return res.status(500).json({ ok: false, error: 'DB not ready' });

    const Orders = db.collection('orders');
    const Messages = db.collection('messages');
    const Unsubs = db.collection('unsubscribes');

    // 1) Build candidate audience from orders collection (unique phones)
    const docs = await Orders
      .find({}, { projection: { phone: 1, name: 1 } })
      .toArray();

    const byPhone = new Map();
    for (const d of docs) {
      const phone = normalizePhone(d.phone);
      if (!phone) continue;
      if (!byPhone.has(phone)) byPhone.set(phone, { phone, name: d.name || 'there' });
    }

    // 2) Exclude people who opted out (unsub collection)
    const unsubPhones = new Set(
      (await Unsubs.find({}, { projection: { phone: 1 } }).toArray()).map(u => u.phone)
    );

    // 3) Exclude people whose latest message matches opt-out tokens
    const latestByPhone = await Messages
      .aggregate([
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$from', last: { $first: '$$ROOT' } } }
      ])
      .toArray();

    for (const g of latestByPhone) {
      const p = g._id;
      const body = g.last?.body || '';
      if (isOptOutText(body)) unsubPhones.add(p);
    }

    // Final audience
    let audience = Array.from(byPhone.values()).filter(x => !unsubPhones.has(x.phone));

    // Limit
    const limit = Math.max(0, Number(req.query.limit || 0));
    if (limit > 0) audience = audience.slice(0, limit);

    // Template / text overrides
    const template = (req.query.template || OFFER_TEMPLATE || '').trim();
    const offerText = (req.query.text || OFFER_TEXT || '').trim();
    if (!template) return res.status(400).json({ ok: false, error: 'Missing template' });
    if (!offerText) return res.status(400).json({ ok: false, error: 'Missing text' });

    // Dry-run?
    const dry = String(req.query.dry || '0') === '1';

    if (dry) {
      return res.json({
        ok: true,
        dry: true,
        template,
        offerText,
        count: audience.length,
        sample: audience.slice(0, 10) // show first 10 preview
      });
    }

    // 4) Send
    let sent = 0, failed = 0;
    const errors = [];

    for (const person of audience) {
      const params = [
        { type: 'text', text: person.name || 'there' }, // {{1}}
        { type: 'text', text: offerText }               // {{2}}
      ];

      try {
        await sendTemplateWithFallback({ to: person.phone, template, parameters: params });
        sent++;
      } catch (e) {
        failed++;
        errors.push({ phone: person.phone, error: e?.response?.data || e?.message || 'send error' });
      }
    }

    res.json({ ok: true, template, offerText, total: audience.length, sent, failed, errors });
  } catch (e) {
    console.error('broadcast error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'Broadcast failed' });
  }
});

// --- Start -------------------------------------------------------------------
app.listen(PORT, () => console.log(`Notifier v5.7.2 listening on :${PORT}`));
