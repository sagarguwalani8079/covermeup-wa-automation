// src/store.js
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error('MONGODB_URI is not defined in environment variables');
}

let db, orders, messages;

async function init() {
  const client = new MongoClient(uri);
  await client.connect();

  // Use DB from URI if provided, otherwise fallback to DB_NAME env
  const dbName = process.env.DB_NAME || uri.split('/').pop().split('?')[0] || 'covermeup';
  db = client.db(dbName);

  // Ensure collections
  orders = db.collection('orders');
  messages = db.collection('messages');

  console.log(`✅ Connected to MongoDB database: ${dbName}`);
}

init().catch(err => {
  console.error('❌ MongoDB connection failed:', err);
  process.exit(1);
});

// ---------- ORDERS ----------
async function addOrder(order) {
  order.createdAt = new Date();
  await orders.insertOne(order);
}

async function getOrders(limit = 50) {
  return orders.find().sort({ createdAt: -1 }).limit(limit).toArray();
}

async function updateLatestOrderByPhone(phone, update) {
  return orders.findOneAndUpdate(
    { phone },
    { $set: { ...update, updatedAt: new Date() } },
    { sort: { createdAt: -1 } }
  );
}

// ---------- MESSAGES ----------
async function addMessage(msg) {
  msg.createdAt = new Date();
  await messages.insertOne(msg);
}

async function getMessages(limit = 50) {
  return messages.find().sort({ createdAt: -1 }).limit(limit).toArray();
}

module.exports = {
  addOrder,
  getOrders,
  updateLatestOrderByPhone,
  addMessage,
  getMessages
};
