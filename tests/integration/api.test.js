const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

let app;
let mongoServer;

beforeAll(async () => {
  // Start in-memory MongoDB
  mongoServer = await MongoMemoryServer.create({ instance: { dbName: 'etsy_inventory_test' } });
  const uri = mongoServer.getUri();

  process.env.MONGODB_URI = uri;
  // Require app after setting env
  app = require('../../server');

  // Wait for mongoose to connect via config/database.js
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Seed deterministic test DB into memory server
  const dataPath = path.join(process.cwd(), 'data', 'test-db.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const db = mongoose.connection.db;
  await db.collection('products').insertMany(data.products || []);
  await db.collection('orders').insertMany(data.orders || []);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('GET /inventory/api/data returns products', async () => {
  const res = await request(app).get('/inventory/api/data?page=1&limit=5');
  expect(res.statusCode).toBe(200);
  expect(res.body).toHaveProperty('products');
  expect(Array.isArray(res.body.products)).toBe(true);
});

test('GET /inventory/product/:sku returns product object', async () => {
  const sku = 'FAKE-SKU-0001';
  const res = await request(app).get(`/inventory/product/${encodeURIComponent(sku)}`);
  expect(res.statusCode).toBe(200);
  expect(res.body).toHaveProperty('sku', sku);
});
