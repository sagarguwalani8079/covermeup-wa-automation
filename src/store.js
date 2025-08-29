// src/store.js
const { MongoClient } = require('mongodb');

const {
  MONGODB_URI,
  DB_NAME = 'covermeup',
} = process.env;

let client, db, orders, messages;

async function init() {
  client = new MongoClient(MONGODB_URI, {
    retryWrites: true,
    tls: true,
  });
  await client.connect();
  db = client.db(DB_NAME);

  orders = db.collection('orders');
  messages = db.collection('messages');

  await orders.createIndex({ phone: 1, createdAt: -1 });
  await orders.createIndex({ orderId: 1 }, { unique: false });
  await messages.createIndex({ from: 1, createdAt: -1 });

  console.log(`✅ Connected to MongoDB database: ${DB_NAME}`);
}

const ensure = (fn) => async (...args) => {
  if (!orders || !messages) throw new Error('DB not ready');
  return fn(...args);
};

// --- Orders ---

const addOrder = ensure(async (doc) => {
  doc.createdAt = new Date();
  doc.updatedAt = new Date();
  await orders.insertOne(doc);
});

const setOrderStatusById = ensure(async (orderId, patch) => {
  patch.updatedAt = new Date();
  await orders.updateOne({ orderId }, { $set: patch });
});

const updateLatestOrderByPhone = ensure(async (phone, patch) => {
  patch.updatedAt = new Date();
  await orders.updateOne(
    { phone },
    { $set: patch },
    { sort: { createdAt: -1 } }
  );
});

const findLatestPendingCODByPhone = ensure(async (phone) => {
  return orders.findOne(
    { phone, cod: true, status: 'pending_cod' },
    { sort: { createdAt: -1 } }
  );
});

// --- Messages ---

const addMessage = ensure(async (doc) => {
  doc.createdAt = new Date();
  await messages.insertOne(doc);
});

module.exports = {
  init,
  addOrder,
  setOrderStatusById,
  updateLatestOrderByPhone,
  findLatestPendingCODByPhone,
  addMessage,
};
