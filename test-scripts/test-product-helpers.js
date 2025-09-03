const { getProductThumbnail, buildShopifyUrl } = require('../utils/product-helpers');

function sampleEtsyProduct() {
  return {
    etsy_data: {
      images: [{ url: 'https://example.com/etsy1.jpg' }],
    },
  };
}

function sampleShopifyRaw() {
  return {
    raw_shopify_data: {
      product: {
        images: { edges: [{ node: { originalSrc: 'https://example.com/shopify1.jpg' } }] },
        online_store_url: 'https://shop.example.com/products/slug',
      },
    },
    shopify_data: { product_id: '12345', handle: 'slug', shop_domain: 'shop.example.com' },
  };
}

function run() {
  console.log('Testing getProductThumbnail with Etsy product...');
  const etsy = sampleEtsyProduct();
  console.log('thumbnail:', getProductThumbnail(etsy));

  console.log('Testing getProductThumbnail with Shopify raw product...');
  const shop = sampleShopifyRaw();
  console.log('thumbnail:', getProductThumbnail(shop));

  console.log('Testing buildShopifyUrl for explicit product_url fallback...');
  const url1 = buildShopifyUrl({ shopify_data: { product_url: 'https://x.com/p' } }, 'myshop');
  console.log('url1:', url1);

  console.log('Testing buildShopifyUrl for shop_domain+handle...');
  const url2 = buildShopifyUrl(shop, 'myshop');
  console.log('url2:', url2);

  console.log('Testing buildShopifyUrl for admin URL using shopifyShopName...');
  const url3 = buildShopifyUrl({ shopify_data: { product_id: '999' } }, 'admin.shopify.com');
  console.log('url3:', url3);

  console.log('All product-helpers tests completed.');
}

run();
