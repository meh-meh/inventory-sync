#!/usr/bin/env node
/**
 * Generate synthetic test data for local testing.
 * - 20 products (10 linked shopify+etsy, 5 only etsy, 5 only shopify)
 * - 20 orders (10 shopify, 10 etsy)
 * Marks inserted docs with `is_test_data: true` to allow easy cleanup.
 * Writes a receipt to tmp/test-data-receipt.json summarizing actions and any skipped sections.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const MONGO = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/etsy_inventory';

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function main() {
  console.log('Connecting to MongoDB:', MONGO);
  await mongoose.connect(MONGO, { maxPoolSize: 10 });
  const db = mongoose.connection.db;

  // Ensure tmp dir exists
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Sample existing products to pick a base name and averages
  const productsColl = db.collection('products');
  const ordersColl = db.collection('orders');

  const sampleProducts = await productsColl.find({}).limit(50).toArray();
  const baseName = (sampleProducts[0] && sampleProducts[0].name) ? sampleProducts[0].name.split(' ')[0] : 'TestProduct';
  const avgOnHand = sampleProducts.length ? Math.max(1, Math.round(sampleProducts.reduce((s,p)=>s+ (p.quantity_on_hand||0),0)/sampleProducts.length)) : 10;
  const avgCommitted = sampleProducts.length ? Math.max(0, Math.round(sampleProducts.reduce((s,p)=>s+ (p.quantity_committed||0),0)/sampleProducts.length)) : 1;

  // Create products
  const products = [];
  for (let i=1;i<=20;i++) {
    const sku = `FAKE-SKU-${String(i).padStart(4,'0')}`;
    const name = `${baseName} ${i}`;
    const onHand = Math.max(0, avgOnHand + randInt(-5,5));
    const committed = Math.max(0, Math.min(onHand, avgCommitted + randInt(-2,2)));

    const hasShopify = i <= 15; // 15 with shopify, 10 both etc - we'll set types below
    const hasEtsy = i > 5; // 15 with etsy

    const product = {
      sku,
      name,
      quantity_on_hand: onHand,
      quantity_committed: committed,
      quantity_available: Math.max(0, onHand - committed),
      last_updated: new Date(),
      raw_shopify_data: hasShopify ? { product: { id: `gid://shopify/Product/${1000+i}`, images: { edges: [{ node: { originalSrc: `https://picsum.photos/seed/shopify${i}/600/400` } }] } } } : null,
      shopify_data: hasShopify ? { product_id: 1000+i, handle: `test-product-${i}`, product_url: `https://example.com/products/test-product-${i}`, quantity: onHand } : {},
      etsy_data: hasEtsy ? { listing_id: 2000+i, quantity: Math.max(0,onHand - randInt(0,2)), images: [{ url_fullxfull: `https://picsum.photos/seed/etsy${i}/600/400` }] } : {},
      thumbnail_url: `https://picsum.photos/seed/thumb${i}/300/200`,
      shopifyShopName: hasShopify ? `shop-${i}` : null,
      shopify_url: hasShopify ? `https://admin.shopify.com/store/shop-${i}/products/${1000+i}` : null,
      is_test_data: true,
      created_at: new Date()
    };
    // Ensure consistent object shape: remove empty objects to mimic real data
    if (!hasShopify) delete product.shopify_data;
    if (!hasEtsy) delete product.etsy_data;
    if (!hasShopify) product.shopifyConnected = false;
    else product.shopifyConnected = true;
    products.push(product);
  }

  const insertRes = await productsColl.insertMany(products);
  console.log(`Inserted ${insertRes.insertedCount} test products.`);

  // Create orders: 10 Shopify, 10 Etsy
  const orders = [];
  const createdSkus = products.map(p=>p.sku);
  for (let i=1;i<=20;i++) {
    const isShopify = i <= 10;
    const numItems = randInt(1,3);
    const items = [];
    for (let j=0;j<numItems;j++) {
      const sku = createdSkus[randInt(0, createdSkus.length-1)];
      items.push({ sku, quantity: randInt(1,3), price: (randInt(1000,5000)/100).toFixed(2), is_digital: false });
    }
    const order = {
      order_id: `${isShopify ? 'S' : 'E'}-TEST-${String(i).padStart(5,'0')}`,
      marketplace: isShopify ? 'shopify' : 'etsy',
      items,
      status: 'unshipped',
      created_at: new Date(Date.now() - randInt(0,7)*24*60*60*1000),
      is_test_data: true
    };
    orders.push(order);
  }

  const ordRes = await ordersColl.insertMany(orders);
  console.log(`Inserted ${ordRes.insertedCount} test orders.`);

  const receipt = {
    generatedAt: new Date().toISOString(),
    mongo: MONGO,
    productsInserted: insertRes.insertedCount,
    ordersInserted: ordRes.insertedCount,
    sampleSkus: products.slice(0,5).map(p=>p.sku),
    notes: 'Products and orders marked with is_test_data: true. No external API calls were made. If you need linked Shopify/Etsy API tests, run them locally with credentials.'
  };

  const receiptPath = path.join(tmpDir, 'test-data-receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log('Wrote receipt to', receiptPath);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err=>{ console.error('Error generating test data:', err); process.exit(2); });
