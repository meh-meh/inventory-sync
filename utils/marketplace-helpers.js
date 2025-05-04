// filepath: c:\Users\Mat\Documents\Etsy_Inventory\utils\marketplace-helpers.js
const etsyHelpers = require('./etsy-helpers');
const shopifyHelpers = require('./shopify-helpers');
const { logger } = require('./logger');

/**
 * Marketplace adapter that provides a unified interface for working with different marketplaces
 */
class MarketplaceAdapter {
    /**
     * Create a new marketplace adapter
     * @param {String} marketplace - 'etsy' or 'shopify'
     */
    constructor(marketplace) {
        this.marketplace = marketplace.toLowerCase();
        
        if (this.marketplace !== 'etsy' && this.marketplace !== 'shopify') {
            throw new Error(`Unsupported marketplace: ${marketplace}`);
        }
    }

    /**
     * Fetch data from the marketplace API
     * @param {String} endpoint - API endpoint
     * @param {Object} options - Fetch options
     * @returns {Promise<Response>} - Fetch response
     */
    async fetch(endpoint, options) {
        try {
            if (this.marketplace === 'etsy') {
                const url = endpoint.startsWith('http') ? endpoint : `${etsyHelpers.API_BASE_URL}${endpoint}`;
                return await etsyHelpers.etsyFetch(url, options);
            } else if (this.marketplace === 'shopify') {
                const url = endpoint.startsWith('http') ? endpoint : `${shopifyHelpers.API_BASE_URL}${endpoint}`;
                return await shopifyHelpers.shopifyFetch(url, options);
            }
        } catch (error) {
            logger.error(`Error in marketplace fetch for ${this.marketplace}`, { error: error.message });
            throw error;
        }
    }

    /**
     * Get authentication headers for marketplace API requests
     * @returns {Object} - Headers with authentication
     */
    getAuthHeaders() {
        if (this.marketplace === 'etsy') {
            return {
                'x-api-key': process.env.ETSY_API_KEY,
                'Authorization': `Bearer ${require('./auth-service').getAccessToken()}`
            };
        } else if (this.marketplace === 'shopify') {
            return shopifyHelpers.getAuthHeaders();
        }
    }

    /**
     * Get shop information from the marketplace
     * @returns {Promise<Object>} - Shop information
     */
    async getShopInfo() {
        try {
            if (this.marketplace === 'etsy') {
                return { shop_id: await etsyHelpers.getShopId() };
            } else if (this.marketplace === 'shopify') {
                return await shopifyHelpers.getShopInfo();
            }
        } catch (error) {
            logger.error(`Error getting shop info for ${this.marketplace}`, { error: error.message });
            throw error;
        }
    }

    /**
     * Convert marketplace-specific product data to a standardized format
     * @param {Object} productData - Raw product data from the marketplace
     * @returns {Object} - Standardized product data
     */
    normalizeProductData(productData) {
        if (this.marketplace === 'etsy') {
            return {
                marketplace_id: productData.listing_id,
                title: productData.title,
                description: productData.description,
                price: productData.price?.amount / productData.price?.divisor,
                quantity: productData.quantity,
                images: productData.images?.map(img => ({
                    url: img.url_fullxfull,
                    alt: img.alt_text || ''
                })) || [],
                tags: productData.tags || [],
                marketplace: 'etsy'
            };
        } else if (this.marketplace === 'shopify') {
            // For Shopify products with variants, this would need to be adapted
            const variant = productData.variants?.[0] || {};
            
            return {
                marketplace_id: productData.id,
                variant_id: variant.id,
                title: productData.title,
                description: productData.body_html,
                price: parseFloat(variant.price || 0),
                quantity: parseInt(variant.inventory_quantity || 0, 10),
                images: productData.images?.map(img => ({
                    url: img.src,
                    alt: img.alt || ''
                })) || [],
                tags: productData.tags ? productData.tags.split(',').map(tag => tag.trim()) : [],
                marketplace: 'shopify'
            };
        }
        
        return null;
    }

    /**
     * Convert marketplace-specific order data to a standardized format
     * @param {Object} orderData - Raw order data from the marketplace
     * @returns {Object} - Standardized order data
     */
    normalizeOrderData(orderData) {
        if (this.marketplace === 'etsy') {
            return {
                order_id: orderData.receipt_id,
                order_number: orderData.receipt_id,
                order_date: new Date(orderData.creation_tsz * 1000),
                buyer_name: `${orderData.name || ''} ${orderData.formatted_address || ''}`.trim(),
                is_shipped: orderData.is_shipped,
                items: (orderData.transactions || []).map(transaction => ({
                    marketplace: 'etsy',
                    sku: transaction.sku || '',
                    quantity: transaction.quantity,
                    listing_id: transaction.listing_id,
                    transaction_id: transaction.transaction_id,
                    receipt_id: orderData.receipt_id
                })),
                raw_data: orderData,
                marketplace: 'etsy'
            };
        } else if (this.marketplace === 'shopify') {
            return {
                order_id: orderData.id.toString(),
                order_number: orderData.order_number.toString() || orderData.name,
                order_date: new Date(orderData.created_at),
                buyer_name: `${orderData.customer?.first_name || ''} ${orderData.customer?.last_name || ''}`.trim(),
                is_shipped: orderData.fulfillment_status === 'fulfilled',
                items: (orderData.line_items || []).map(item => ({
                    marketplace: 'shopify',
                    sku: item.sku || '',
                    quantity: item.quantity,
                    product_id: item.product_id,
                    variant_id: item.variant_id,
                    line_item_id: item.id
                })),
                raw_data: orderData,
                marketplace: 'shopify'
            };
        }
        
        return null;
    }
}

/**
 * Factory function to create a marketplace adapter
 * @param {String} marketplace - 'etsy' or 'shopify'
 * @returns {MarketplaceAdapter} - Marketplace adapter instance
 */
function createMarketplaceAdapter(marketplace) {
    return new MarketplaceAdapter(marketplace);
}

module.exports = {
    createMarketplaceAdapter
};