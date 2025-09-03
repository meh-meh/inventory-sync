const fetch = require('node-fetch');

async function run() {
  const base = process.env.BASE_URL || 'http://127.0.0.1:3003';
  console.log('Running smoke tests against', base);

  try {
    const res = await fetch(`${base}/inventory/api/data?page=1&limit=1`);
    console.log('/inventory/api/data ->', res.status);
    if (!res.ok) throw new Error('inventory api data failed');
    const body = await res.json();
    if (!body.products || body.products.length === 0) {
      console.warn('No products returned by API (this may be fine for an empty DB)');
      process.exit(0);
    }
    const sku = body.products[0].sku;
    console.log('Found product SKU:', sku);

    const res2 = await fetch(`${base}/inventory/product/${encodeURIComponent(sku)}`);
    console.log(`/inventory/product/${sku} ->`, res2.status);
    if (!res2.ok) throw new Error('product endpoint failed');
    const product = await res2.json();
    console.log('Product keys:', Object.keys(product).join(', '));

    console.log('Smoke test PASSED');
    process.exit(0);
  } catch (err) {
    console.error('Smoke test FAILED:', err.message || err);
    process.exit(2);
  }
}

run();
