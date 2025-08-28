// src/store.js
// Mongo-backed store with one-time connection and safe getters.

const { MongoClient } = require('mongodb');

const {
  MONGODB_URI,
  MONGODB_DB = 'covermeup',
} = process.env;

let client;
let db;
let initError = null;

// Kick off a single connection attempt at module load
const initPromise = (async () => {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not set');
  client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
    retryWrites: true,
  });
  await client.connect();
  db = client.db(MONGODB_DB);
  console.log(`✅ Connected to MongoDB database: ${MONGODB_DB}`);
})().catch(err => {
  initError = err;
  console.error('❌ MongoDB connection failed:', err);
});

async function getDb() {
  if (db) return db;
  await initPromise;
  if (db) return db;
  if (initError) throw initError;
  throw new Error('DB not initialized');
}

async function col(name) {
  const _db = await getDb();
  return _db.collection(name);
}

// Public API used by server.js
async function addOrder(order) {
  const orders = await col('orders');
  await orders.insertOne({ ...order, createdAt: new Date() });
}

async function addMessage(msg) {
  const messages = await col('messages');
  await messages.insertOne({ ...msg, createdAt: new Date() });
}

async function updateLatestOrderByPhone(phone, patch) {
  const orders = await col('orders');
  await orders.findOneAndUpdate(
    { phone },
    { $set: { ...patch, updatedAt: new Date() } },
    { sort: { createdAt: -1 } }
  );
}

module.exports = {
  getDb,
  addOrder,
  addMessage,
  updateLatestOrderByPhone,
};
