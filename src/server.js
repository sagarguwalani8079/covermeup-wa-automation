// Safe optional dotenv load for local dev
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

  // Templates
  ORDER_CONFIRMATION_TEMPLATE = 'order_confirmation', // prepaid
  COD_TEMPLATE = 'cod_confirm_v3',                     // COD buttons template (new)

  // COD parameter order (comma list of tokens: NAME,ORDER,BRAND,TOTAL,ITEMS)
  COD_PARAM_ORDER = 'NAME,ORDER,BRAND',

  // Defaults
  WA_TEMPLATE_LANG = 'en_US',
  FALLBACK_TEMPLATE = 'cmu_fallback_0',
  WHATSAPP_VERIFY_TOKEN,
  BRAND_NAME = 'CoverMeUp',
  DEFAULT_COUNTRY_CODE = '91'
} = process.env;

// parsers
app.use('/webhooks/shopify', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

// health
app.get('/health', (req, res) => res.json({ ok: true }));

// WA verify
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.status(403).send('Forbidden');
});

// WA inbound (logs + saves)
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

      if (yes)      await store.updateLatestOrderByPhone(from, { status: 'confirmed', lastReply: body });
      else if (no)  await store.updateLatestOrderByPhone(from, { status: 'rejected',  lastReply: body });
      else          await store.updateLatestOrderByPhone(from, {                     lastReply: body });
    }
    res.send('ok');
  } catch (e) {
    console.error('WA inbound error:', e?.message || e);
    res.send('err');
  }
});

// ---------- helpers ----------
function verifyShopifyHmac(req) {
  const h = req.get('X-Shopify-Hmac-Sha256') || '';
  const d = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET || '')
    .update(req.body)
    .digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(d), Buffer.from(h)); }
  catch { return false; }
}

function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `${DEFAULT_COUNTRY_CODE}${d}`;
  if (d.startsWith('0') && d.length === 11) return `${DEFAULT_COUNTRY_CODE}${d.slice(1)}`;
  return d;
}

async function waSend({ to, template, bodyParams, headerImageUrl }) {
  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: template, language: { code: WA_TEMPLATE_LANG } }
  };

  const components = [];

  if (Array.isArray(bodyParams) && bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) });
  }

  if (headerImageUrl) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] });
  }

  if (components.length) payload.template.components = components;

  console.log('[WA SEND]', JSON.stringify({ to, template, components: payload.template.components || undefined }, null, 2));

  return axios.post(url, payload, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
}

async function waSendWithFallback({ to, template, bodyParams, headerImageUrl }) {
  try {
    return await waSend({ to, template, bodyParams, headerImageUrl });
  } catch (e) {
    const data = e?.response?.data;
    console.error(`[WA SEND ERROR - ${template}]`, { error: data || e });
    try {
      console.log('[WA SEND]', JSON.stringify({ to, template: FALLBACK_TEMPLATE }, null, 2));
      return await waSend({ to, template: FALLBACK_TEMPLATE });
    } catch (e2) {
      console.error('[WA SEND FALLBACK ERROR]', { error: e2?.response?.data || e2 });
      throw e;
    }
  }
}

// Heuristic to detect COD from the Shopify order payload
function isCOD(order) {
  const gateways = (order?.payment_gateway_names || []).map(s => String(s).toLowerCase()).join(' ');
  const gateway  = String(order?.gateway || '').toLowerCase();
  const tags     = String(order?.tags || '').toLowerCase();
  const fin      = String(order?.financial_status || '').toLowerCase();

  const hit =
    gateways.includes('cod') ||
    gateways.includes('cash') ||
    gateway.includes('cod') ||
    gateway.includes('cash') ||
    tags.includes('cod') ||
    tags.includes('cash on delivery') ||
    (fin === 'pending' && (gateways || gateway));

  return !!hit;
}

// Build COD params in the exact order requested by COD_PARAM_ORDER
function buildCodParams({ name, orderId, brand, total, items }) {
  const map = {
    NAME: name,
    ORDER: orderId,
    BRAND: brand,
    TOTAL: total,
    ITEMS: items
  };
  return String(COD_PARAM_ORDER)
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(k => map[k] != null)
    .map(k => map[k]);
}

// ---------- Shopify: orders create ----------
app.post('/webhooks/shopify/orders-create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');

  const o = JSON.parse(req.body.toString('utf8'));

  const phone = normalizePhone(o.phone || o.customer?.phone || o.shipping_address?.phone);
  if (!phone) return res.send('No phone');

  const name    = o?.shipping_address?.name || o?.customer?.first_name || 'there';
  const orderId = o.name || String(o.id);
  const total   = `₹${(Number(o.total_price) || 0).toFixed(2)}`;
  const items   = (o.line_items || []).map(li => `${li.title} x${li.quantity}`).join(', ').slice(0, 900);

  // Persist (best-effort)
  await store.addOrder({ id: o.id, orderId, phone, name, total, items, status: 'pending' });

  const cod = isCOD(o);
  const templateToUse = cod ? COD_TEMPLATE : ORDER_CONFIRMATION_TEMPLATE;

  // PREPAID template expects: name, orderId, BRAND, total, items
  const prepaidParams = [name, orderId, BRAND_NAME, total, items];

  // COD template params built from env order
  const codParams = buildCodParams({
    name,
    orderId,
    brand: BRAND_NAME,
    total,
    items
  });

  try {
    await waSendWithFallback({
      to: phone,
      template: templateToUse,
      bodyParams: cod ? codParams : prepaidParams
    });
  } catch (_) {
    // errors already logged
  }

  res.send('ok');
});

// ---------- admin broadcast ----------
// GET /admin/broadcast?key=...&template=...&to=...&p1=..&p2=..&img=https://...
app.get('/admin/broadcast', async (req, res) => {
  try {
    const { key, template, to, dry, img, ...rest } = req.query;
    if (key !== 'covermeup123') return res.status(403).json({ ok: false, error: 'bad key' });

    const phones = (to ? String(to).split(',') : []).map(normalizePhone).filter(Boolean);
    const parametersPreview = Object.keys(rest)
      .filter(k => /^p\d+$/i.test(k))
      .sort((a,b) => Number(a.slice(1)) - Number(b.slice(1)))
      .map(k => String(rest[k]));

    if (dry === '1') {
      return res.json({
        ok: true,
        dry: true,
        template,
        parametersPreview,
        audienceCount: phones.length,
        sample: phones.slice(0, 10)
      });
    }

    const results = [];
    for (const ph of phones) {
      try {
        await waSendWithFallback({
          to: ph,
          template,
          bodyParams: parametersPreview,
          headerImageUrl: img
        });
        results.push({ to: ph, ok: true });
      } catch (e) {
        results.push({ to: ph, ok: false, error: e?.response?.data || e?.message || String(e) });
      }
    }

    res.json({ ok: true, template, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, total: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`Notifier v5.7.2 listening on :${PORT}`));
