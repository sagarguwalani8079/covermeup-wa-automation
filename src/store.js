const { MongoClient } = require('mongodb');

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || 'covermeup';

let client, db, orders, messages;

async function init() {
  if (!client) {
    client = new MongoClient(uri, { useUnifiedTopology: true });
    await client.connect();
    db = client.db(dbName);
    orders = db.collection('orders');
    messages = db.collection('messages');
    console.log('[MongoDB] Connected');
  }
}
init();

module.exports = {
  async addOrder(order) {
    await init();
    await orders.updateOne({ id: order.id }, { $set: order }, { upsert: true });
  },

  async addMessage(msg) {
    await init();
    await messages.insertOne({ ...msg, ts: new Date() });
  },

  async updateLatestOrderByPhone(phone, update) {
    await init();
    await orders.updateOne(
      { phone },
      { $set: { ...update, updatedAt: new Date() } },
      { sort: { updatedAt: -1 } }
    );
  },

  async getOrders() {
    await init();
    return orders.find().sort({ updatedAt: -1 }).toArray();
  }
};
