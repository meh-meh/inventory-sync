#!/usr/bin/env node
/**
 * Load deterministic test DB from data/test-db.json into MongoDB test database.
 * Drops any documents in products/orders that have is_test_data:true before inserting.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const filePath = path.join(process.cwd(), 'data', 'test-db.json');
if (!fs.existsSync(filePath)) {
  console.error('Test DB file not found:', filePath);
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const MONGO = process.env.MONGODB_URI || process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/etsy_inventory_test';

async function main() {
  console.log('Connecting to MongoDB:', MONGO);
  await mongoose.connect(MONGO, { maxPoolSize: 10 });
  const db = mongoose.connection.db;

  const productsColl = db.collection('products');
  const ordersColl = db.collection('orders');

  // Remove previous test docs
  await productsColl.deleteMany({ is_test_data: true });
  await ordersColl.deleteMany({ is_test_data: true });

  // Insert deterministic data
  if (Array.isArray(data.products) && data.products.length) {
    await productsColl.insertMany(data.products.map(p => ({ ...p })));
    console.log(`Inserted ${data.products.length} products`);
  }
  if (Array.isArray(data.orders) && data.orders.length) {
    await ordersColl.insertMany(data.orders.map(o => ({ ...o })));
    console.log(`Inserted ${data.orders.length} orders`);
  }

  const receipt = {
    loadedAt: new Date().toISOString(),
    mongo: MONGO,
    products: data.products.length,
    orders: data.orders.length
  };
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test-db-load-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log('Wrote receipt to tmp/test-db-load-receipt.json');

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => { console.error('Failed to load test DB:', err); process.exit(2); });
