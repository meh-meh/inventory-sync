/**
 * Small helper utilities for product-related derived fields
 */
function getProductThumbnail(product) {
  if (!product) return null;
  try {
    if (product.etsy_data && Array.isArray(product.etsy_data.images) && product.etsy_data.images.length > 0) {
      return product.etsy_data.images[0].url || null;
    }

    const rawProd = product.raw_shopify_data && product.raw_shopify_data.product ? product.raw_shopify_data.product : null;
    if (rawProd && rawProd.images && Array.isArray(rawProd.images.edges) && rawProd.images.edges.length > 0) {
      const first = rawProd.images.edges[0];
      return (first && first.node && (first.node.originalSrc || first.node.url)) || null;
    }

    if (rawProd && rawProd.online_store_url) return rawProd.online_store_url;
  } catch {
    // swallow and return null
  }
  return null;
}

function buildShopifyUrl(product, shopifyShopName) {
  if (!product) return null;
  // Prefer an explicit product_url provided by shopify_data
  const sd = product.shopify_data || {};
  if (sd.product_url) return sd.product_url;

  // If we have a public shop domain and a handle, build storefront link
  if (sd.shop_domain && sd.handle) return `https://${sd.shop_domain}/products/${sd.handle}`;

  // If we have a shopify admin store name and a product id, use admin URL
  if (shopifyShopName && sd.product_id) return `https://${shopifyShopName}/admin/products/${sd.product_id}`;

  // Fallback to raw shopify product online_store_url
  const raw = product.raw_shopify_data && product.raw_shopify_data.product ? product.raw_shopify_data.product : null;
  if (raw && raw.online_store_url) return raw.online_store_url;

  return null;
}

module.exports = {
  getProductThumbnail,
  buildShopifyUrl,
};
