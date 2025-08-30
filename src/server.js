// server.js
// CoverMeUp WhatsApp Notifier — combined COD template version

// Safe optional dotenv load (does nothing in prod if not present)
try { require("dotenv").config(); } catch (_) {}

const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const bodyParser = require("body-parser");
const store = require("./store");

const app = express();

// ----- ENV -----
const {
  PORT = 3000,

  // Shopify
  SHOPIFY_WEBHOOK_SECRET,

  // WhatsApp Cloud API
  WA_TOKEN,
  WA_PHONE_ID,
  WA_GRAPH_VERSION = "v20.0",
  WA_TEMPLATE_LANG = "en_US",

  // Template names
  ORDER_CONFIRMATION_TEMPLATE = "order_confirmation", // prepaid
  COD_TEMPLATE = "cod_confirm_v3",                    // combined COD template

  // Business defaults
  BRAND_NAME = "CoverMeUp",
  DEFAULT_COUNTRY_CODE = "91",
  WHATSAPP_VERIFY_TOKEN
} = process.env;

// ----- MIDDLEWARE -----
app.use("/webhooks/shopify", bodyParser.raw({ type: "application/json" }));
app.get("/health", (_, res) => res.json({ ok: true }));
app.use(bodyParser.json());

// ----- HELPERS -----

// Verify Shopify HMAC header
function verifyShopifyHmac(req) {
  const signature = req.get("X-Shopify-Hmac-Sha256") || "";
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET || "")
    .update(req.body)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Normalize phone: add default country if 10-digit Indian number, strip non-digits
function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  if (d.length === 10) return `${DEFAULT_COUNTRY_CODE}${d}`;
  if (d.startsWith("0") && d.length === 11) return `${DEFAULT_COUNTRY_CODE}${d.slice(1)}`;
  return d;
}

// Generic template sender (optionally with body params & header image)
async function sendTemplate({ to, template, bodyParams = [], headerImage = null }) {
  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template,
      language: { code: WA_TEMPLATE_LANG }
    }
  };

  const components = [];

  if (headerImage) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { link: headerImage } }]
    });
  }

  if (bodyParams && bodyParams.length) {
    components.push({
      type: "body",
      parameters: bodyParams.map((t) => ({ type: "text", text: String(t).slice(0, 1024) }))
    });
  }

  if (components.length) payload.template.components = components;

  console.log("[WA SEND]", JSON.stringify({ to, template, components: payload.template.components || [] }, null, 2));
  await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` }
  });
}

// Determine if order is COD
function isCODOrder(order) {
  try {
    // Shopify provides payment gateways as names array; also check payment terms & tags
    const gateways = (order.payment_gateway_names || []).join(" ").toLowerCase();
    const terms = (order.payment_terms && order.payment_terms.payment_terms_name || "").toLowerCase();
    const tags = (order.tags || "").toLowerCase();

    if (gateways.includes("cod") || gateways.includes("cash on delivery")) return true;
    if (terms.includes("cod") || terms.includes("cash on delivery")) return true;
    if (tags.includes("cod")) return true;

    // Fallback heuristic: unpaid/pending + not a known prepaid gateway
    const fs = (order.financial_status || "").toLowerCase();
    if (fs === "pending" && !gateways) return true;

    return false;
  } catch {
    return false;
  }
}

// Build common order fields
function extractOrderBasics(o) {
  const to = normalizePhone(o.phone || o.customer?.phone || o.shipping_address?.phone);
  const name = o?.shipping_address?.name || o?.customer?.first_name || "there";
  const orderId = o.name || String(o.id);
  const total = `₹${(Number(o.total_price) || 0).toFixed(2)}`;
  const items = (o.line_items || [])
    .map((li) => `${li.title} x${li.quantity}`)
    .join(", ")
    .slice(0, 900);

  return { to, name, orderId, total, items };
}

// ----- WEBHOOKS -----

// WA Webhook verify
app.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.status(403).send("Forbidden");
});

// WA inbound (optional: save messages)
app.post("/webhooks/whatsapp", async (req, res) => {
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages || [];
    for (const m of messages) {
      const from = m.from;
      let body = "";
      if (m.text?.body) body = m.text.body.trim();
      if (m.button?.text) body = m.button.text.trim();
      await store.addMessage({ from, body, type: m.type, id: m.id });

      // capture simple yes/no for your internal state if you want
      const yes = /^(yes|y|confirm|ok|okay|confirmed)$/i.test(body);
      const no = /^(no|n|cancel|reject|stop)$/i.test(body);
      if (yes) await store.updateLatestOrderByPhone(from, { status: "confirmed", lastReply: body });
      else if (no) await store.updateLatestOrderByPhone(from, { status: "rejected", lastReply: body });
      else await store.updateLatestOrderByPhone(from, { lastReply: body });
    }
    res.send("ok");
  } catch (e) {
    console.error("WA inbound error:", e?.message || e);
    res.send("err");
  }
});

// Shopify: Orders Create
app.post("/webhooks/shopify/orders-create", async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send("Unauthorized");

  const order = JSON.parse(req.body.toString("utf8"));
  const { to, name, orderId, total, items } = extractOrderBasics(order);
  if (!to) return res.send("No phone");

  // Save to DB
  await store.addOrder({
    id: order.id,
    orderId,
    phone: to,
    name,
    total,
    items,
    status: "pending"
  });

  const cod = isCODOrder(order);

  try {
    if (cod) {
      // Single combined message: summary + confirm/cancel buttons (defined in template)
      await sendTemplate({
        to,
        template: COD_TEMPLATE,
        bodyParams: [name, BRAND_NAME, orderId, total, items]
        // headerImage: <optional image URL if your template uses an IMAGE header>
      });
    } else {
      // Prepaid confirmation (plain summary)
      await sendTemplate({
        to,
        template: ORDER_CONFIRMATION_TEMPLATE,
        bodyParams: [name, orderId, BRAND_NAME, total, items]
      });
    }
  } catch (e) {
    console.error(`[WA SEND ERROR - ${cod ? COD_TEMPLATE : ORDER_CONFIRMATION_TEMPLATE}]`, e?.response?.data || e?.message || e);
  }

  res.send("ok");
});

// ----- START -----
app.listen(PORT, () => {
  console.log(`Notifier (combined COD) listening on :${PORT}`);
});
