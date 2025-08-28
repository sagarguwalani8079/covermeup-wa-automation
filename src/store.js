// src/store.js
// Mongo-backed data store for orders & messages

const { MongoClient } = require('mongodb');

const {
  MONGODB_URI,
  DB_NAME = 'covermeup',
} = process.env;

let client;
let db;
let ordersCol;
let messagesCol;

// Connect once on boot
async function init() {
  if (db) return db;
  if (!MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI not set; store will remain disabled.');
    return null;
  }
  client = new MongoClient(MONGODB_URI, {
    // sensible defaults for Atlas
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 15000,
  });
  await client.connect();
  db = client.db(DB_NAME);
  ordersCol = db.collection('orders');
  messagesCol = db.collection('messages');

  // Helpful indexes
  await Promise.all([
    ordersCol.createIndex({ phone: 1, createdAt: -1 }),
    ordersCol.createIndex({ orderId: 1 }, { unique: false }),
    messagesCol.createIndex({ from: 1, createdAt: -1 }),
  ]);

  console.log(`✅ Connected to MongoDB database: ${DB_NAME}`);
  return db;
}

// Utility to ensure connection for every public method
async function ready() {
  if (!db) {
    try { await init(); } catch (e) {
      console.error('❌ MongoDB connection failed:', e);
      return null;
    }
  }
  return db;
}

// ------- Public API -------

exports.addOrder = async function addOrder(order) {
  if (!await ready()) return;
  const now = new Date();
  const doc = {
    ...order,
    createdAt: order.createdAt ? new Date(order.createdAt) : now,
    updatedAt: now,
  };
  await ordersCol.insertOne(doc);
};

exports.updateLatestOrderByPhone = async function updateLatestOrderByPhone(phone, patch) {
  if (!await ready()) return;
  await ordersCol.findOneAndUpdate(
    { phone },
    { $set: { ...patch, updatedAt: new Date() } },
    { sort: { createdAt: -1 } }
  );
};

exports.addMessage = async function addMessage(msg) {
  if (!await ready()) return;
  await messagesCol.insertOne({
    ...msg,
    createdAt: new Date(),
  });
};

exports.getRecentOrders = async function getRecentOrders(limit = 50) {
  if (!await ready()) return [];
  return ordersCol.find({}, { limit }).sort({ createdAt: -1 }).toArray();
};

exports.getRecentMessages = async function getRecentMessages(limit = 50) {
  if (!await ready()) return [];
  return messagesCol.find({}, { limit }).sort({ createdAt: -1 }).toArray();
};
