// src/store.js
const { MongoClient, ServerApiVersion } = require('mongodb');

const {
  MONGODB_URI,
  DB_NAME = 'covermeup',
} = process.env;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set in env. Mongo will not connect.');
}

let client;
let db;
let orders;
let messages;

// one-time connect promise (shared by all callers)
let _readyPromise;

/**
 * Connect to MongoDB once and memoize the collections.
 * Safe to call multiple times; subsequent calls await the same promise.
 */
function init() {
  if (_readyPromise) return _readyPromise;

  _readyPromise = (async () => {
    if (!MONGODB_URI) return;

    // Node 18 + Atlas (SNI+TLS). Use Server API to quiet deprecations.
    client = new MongoClient(MONGODB_URI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      // sensible timeouts for cold starts
      connectTimeoutMS: 12000,
      socketTimeoutMS: 20000,
      retryWrites: true,
      maxPoolSize: 5,
    });

    try {
      await client.connect();
      db = client.db(DB_NAME);
      orders = db.collection('orders');
      messages = db.collection('messages');
      console.log(`✅ Connected to MongoDB database: ${DB_NAME}`);
    } catch (err) {
      console.error('❌ MongoDB connection failed:', err);
      // Don't reject permanently — allow later awaits to try again
      _readyPromise = null;
      throw err;
    }
  })();

  return _readyPromise;
}

/** Await until collections are ready (retry on cold start). */
async function ensureReady() {
  // already good
  if (orders && messages) return;

  // existing connect in progress
  try {
    await init();
  } catch (e) {
    // brief backoff, then try once more on this call
    await new Promise(r => setTimeout(r, 1500));
    await init();
  }
}

/* -----------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------*/

module.exports = {
  /** For health checks / tests */
  async isReady() {
    try {
      await ensureReady();
      return true;
    } catch {
      return false;
    }
  },

  /** Persist an inbound WA message for the dashboard */
  async addMessage(doc) {
    await ensureReady();
    const now = new Date();
    await messages.insertOne({
      ...doc,
      createdAt: now,
      updatedAt: now,
    });
  },

  /** Create an order record */
  async addOrder(doc) {
    await ensureReady();
    const now = new Date();
    const toInsert = {
      orderId: doc.orderId,
      id: doc.id,              // shopify numeric id
      phone: doc.phone,
      name: doc.name,
      total: doc.total,
      items: doc.items,
      status: doc.status || 'pending',
      lastReply: doc.lastReply || '',
      createdAt: now,
      updatedAt: now,
    };
    await orders.insertOne(toInsert);
  },

  /** Update the **latest** order for a phone (used by COD / yes-no reply) */
  async updateLatestOrderByPhone(phone, patch) {
    await ensureReady();
    const now = new Date();
    await orders.findOneAndUpdate(
      { phone },
      { $set: { ...patch, updatedAt: now } },
      { sort: { createdAt: -1 } }
    );
  },

  /** Dashboard — most recent orders */
  async getRecentOrders(limit = 50) {
    await ensureReady();
    return orders
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  },

  /** Dashboard — most recent messages */
  async getRecentMessages(limit = 50) {
    await ensureReady();
    return messages
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  },
};
