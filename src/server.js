// src/store.js
const { MongoClient } = require('mongodb');

const {
  MONGODB_URI,
  MONGODB_DBNAME = 'covermeup',
} = process.env;

let client;
let db;
let orders;
let messages;

const state = {
  ready: false,
};

/**
 * Initialize Mongo connection (fires immediately on import).
 */
async function init() {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI is not set. Database will not be ready.');
    return;
  }

  try {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      // keep defaults—Atlas uses TLS by default from the SRV URI
      // (no need to override unless your platform has custom OpenSSL needs)
    });

    await client.connect();
    db = client.db(MONGODB_DBNAME);

    // quick ping/health check
    await db.command({ ping: 1 });

    // collections
    orders = db.collection('orders');
    messages = db.collection('messages');

    // helpful indexes
    await Promise.all([
      orders.createIndex({ phone: 1, createdAt: -1 }),
      orders.createIndex({ orderId: 1 }, { unique: false }),
      messages.createIndex({ from: 1, createdAt: -1 }),
    ]);

    state.ready = true;
    console.log(`✅ Connected to MongoDB database: ${db.databaseName}`);
  } catch (err) {
    state.ready = false;
    console.error('❌ MongoDB connection failed:', err);
  }
}

// kick off connection
init();

/* ------------------------ CRUD helpers ------------------------ */

function ensureReady() {
  if (!state.ready || !orders || !messages) {
    throw new Error('DB not ready');
  }
}

/**
 * Add a new order document.
 * Shape is flexible—server passes: { id, orderId, phone, name, total, items, status }
 */
async function addOrder(order) {
  ensureReady();
  const doc = {
    ...order,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await orders.insertOne(doc);
  return doc;
}

/**
 * Add an inbound WhatsApp message (or any message we want to log).
 * Expected: { from, body, type, id }
 */
async function addMessage(msg) {
  ensureReady();
  const doc = {
    ...msg,
    createdAt: new Date(),
  };
  await messages.insertOne(doc);
  return doc;
}

/**
 * Update the most recent order for a phone number.
 * E.g. set { status: 'cod_confirmed' } or { lastReply: 'Yes' }
 */
async function updateLatestOrderByPhone(phone, updates = {}) {
  ensureReady();
  const filter = { phone };
  const update = {
    $set: { ...updates, updatedAt: new Date() },
  };
  const options = {
    sort: { createdAt: -1 },
    returnDocument: 'after',
  };
  const res = await orders.findOneAndUpdate(filter, update, options);
  return res.value;
}

/* ------------------------ Optional helpers ------------------------ */

/** Get recent orders (for diagnostics/admin) */
async function getOrders(limit = 50) {
  ensureReady();
  return orders
    .find({})
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(200, limit)))
    .toArray();
}

/** Get recent messages (for diagnostics/admin) */
async function getMessages(limit = 100) {
  ensureReady();
  return messages
    .find({})
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(500, limit)))
    .toArray();
}

/* ------------------------ Exports ------------------------ */

module.exports = {
  // state
  get ready() {
    return state.ready;
  },

  // main ops
  addOrder,
  addMessage,
  updateLatestOrderByPhone,

  // optional
  getOrders,
  getMessages,
};
