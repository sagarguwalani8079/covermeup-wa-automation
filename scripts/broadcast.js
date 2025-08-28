// scripts/broadcast.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const readline = require('readline');
const { MongoClient } = require('mongodb');

const {
  WA_TOKEN,
  WA_PHONE_ID,
  WA_GRAPH_VERSION = 'v20.0',
  WA_TEMPLATE_LANG = 'en_US',
  BRAND_NAME = 'CoverMeUp',
  BROADCAST_TEMPLATE = 'new_drop_offer', // <- your approved template name
  CSV_PATH = './customers.csv',
  MONGODB_URI,
  DB_NAME = 'covermeup',
  DISCOUNT_CODE = 'NEW15',
  DISCOUNT_TEXT = '15%',
  LANDING_URL = 'https://covermeup.in/new'
} = process.env;

const WA_URL = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_ID}/messages`;

async function sendTemplate(to, params, templateName = BROADCAST_TEMPLATE) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: WA_TEMPLATE_LANG },
      components: [{ type: 'body', parameters: params }]
    }
  };
  try {
    const { data } = await axios.post(WA_URL, payload, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });
    return { ok: true, data };
  } catch (e) {
    const details = e?.response?.data;
    return { ok: false, error: details || e.message };
  }
}

function normPhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.startsWith('0') && d.length === 11) return '91' + d.slice(1);
  return d; // assume already E.164 w/o +
}

async function main() {
  // Optional: connect to Mongo to skip opt-outs
  let db = null;
  if (MONGODB_URI) {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('Connected to MongoDB for opt-out check.');
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(path.resolve(CSV_PATH)),
    crlfDelay: Infinity
  });

  // crude CSV parser (expects headers)
  let headers = [];
  let lineNum = 0;
  let sent = 0, failed = 0, skipped = 0;

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;

    if (lineNum === 1) {
      headers = line.split(',').map(h => h.trim().toLowerCase());
      continue;
    }

    const cols = line.split(',').map(c => c.trim());
    const row = Object.fromEntries(headers.map((h, i) => [h, cols[i] || '']));

    const name = row.first_name || row.name || row['shipping name'] || 'there';
    const to = normPhone(row.phone || row['shipping phone'] || row['customer phone']);

    if (!to) { skipped++; continue; }

    // Optional skip: if last status in orders is rejected or you store opt-outs
    if (db) {
      const latestRejected = await db.collection('orders').findOne({
        phone: to, status: 'rejected'
      }, { projection: { _id: 1 } });
      if (latestRejected) { skipped++; continue; }
    }

    const params = [
      { type: 'text', text: name },
      { type: 'text', text: BRAND_NAME },
      { type: 'text', text: DISCOUNT_CODE },
      { type: 'text', text: DISCOUNT_TEXT },
      { type: 'text', text: LANDING_URL }
    ];

    const res = await sendTemplate(to, params);
    if (res.ok) {
      sent++;
      console.log(`✓ Sent to ${to}`);
    } else {
      failed++;
      console.log(`✗ ${to} ->`, res.error);
    }

    // Pace to avoid spikes: ~10 msgs/sec; adjust by your tier/number quality
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
