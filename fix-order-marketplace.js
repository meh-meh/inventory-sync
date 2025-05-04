/**
 * Utility script to fix orders with missing marketplace field
 * 
 * This script identifies orders in the database that are missing the 'marketplace' field
 * and updates them based on marketplace-specific fields (receipt_id for Etsy, shopify_order_number for Shopify)
 * 
 * Run with: node fix-order-marketplace.js
 */

const mongoose = require('mongoose');
const Order = require('./models/order');
require('./config/database');
const { logger } = require('./utils/logger');

async function fixOrderMarketplaceFields() {
    logger.info('Starting order marketplace field fix script');
    
    try {
        // Find orders with missing marketplace field - use lean() to get plain objects
        // instead of Mongoose documents to avoid validation issues
        const missingMarketplaceOrders = await Order.find({
            $or: [
                { marketplace: { $exists: false } },
                { marketplace: null },
                { marketplace: '' }
            ]
        }).lean();
        
        logger.info(`Found ${missingMarketplaceOrders.length} orders with missing marketplace field`);
        
        if (missingMarketplaceOrders.length === 0) {
            logger.info('No orders need fixing. Exiting...');
            mongoose.disconnect();
            return;
        }
        
        let etsyCount = 0;
        let shopifyCount = 0;
        let unidentifiedCount = 0;
        let failedUpdates = 0;

        // Process each order
        for (const order of missingMarketplaceOrders) {
            try {
                // Determine marketplace based on available fields
                let marketplace = null;
                
                if (order.receipt_id) {
                    marketplace = 'etsy';
                    etsyCount++;
                    logger.info(`Setting order ${order.order_id || order._id} (receipt_id: ${order.receipt_id}) as Etsy marketplace`);
                } else if (order.shopify_order_number) {
                    marketplace = 'shopify';
                    shopifyCount++;
                    logger.info(`Setting order ${order.order_id || order._id} (shopify_order: ${order.shopify_order_number}) as Shopify marketplace`);
                } else {
                    // Try to determine from order items
                    if (order.items && order.items.length > 0) {
                        // Check if any items have marketplace-specific fields
                        const hasEtsyItems = order.items.some(item => item.listing_id || item.transaction_id);
                        const hasShopifyItems = order.items.some(item => item.variant_id || item.product_id);
                        
                        if (hasEtsyItems && !hasShopifyItems) {
                            marketplace = 'etsy';
                            etsyCount++;
                            logger.info(`Determined order ${order.order_id || order._id} as Etsy based on items`);
                        } else if (hasShopifyItems && !hasEtsyItems) {
                            marketplace = 'shopify';
                            shopifyCount++;
                            logger.info(`Determined order ${order.order_id || order._id} as Shopify based on items`);
                        } else {
                            unidentifiedCount++;
                            logger.warn(`Order ${order.order_id || order._id} has ambiguous or missing item marketplace data`);
                        }
                    } else {
                        unidentifiedCount++;
                        logger.warn(`Could not identify marketplace for order ${order.order_id || order._id} - no receipt_id, shopify_order_number, or items found`);
                    }
                }
                
                // Update order directly in the database if marketplace was determined
                if (marketplace) {
                    // First, check if order_id is missing and generate one if needed
                    if (!order.order_id) {
                        if (marketplace === 'etsy' && order.receipt_id) {
                            order.order_id = `etsy-${order.receipt_id}`;
                            logger.info(`Generated order_id ${order.order_id} for Etsy order with receipt_id ${order.receipt_id}`);
                        } else if (marketplace === 'shopify' && order.shopify_order_number) {
                            order.order_id = `shopify-${order.shopify_order_number}`;
                            logger.info(`Generated order_id ${order.order_id} for Shopify order with order number ${order.shopify_order_number}`);
                        } else {
                            // Generate a random order ID if we can't derive one
                            order.order_id = `gen-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
                            logger.info(`Generated random order_id ${order.order_id} for order with missing ID`);
                        }
                    }
                    
                    // Update order marketplace field directly using updateOne to bypass validation
                    await Order.updateOne(
                        { _id: order._id },
                        { 
                            $set: { 
                                marketplace: marketplace,
                                order_id: order.order_id
                            } 
                        }
                    );
                    
                    // Fix item marketplace fields in a separate update to avoid validation issues
                    if (order.items && order.items.length > 0) {
                        const updates = {};
                        
                        order.items.forEach((item, index) => {
                            updates[`items.${index}.marketplace`] = marketplace;
                        });
                        
                        await Order.updateOne(
                            { _id: order._id },
                            { $set: updates }
                        );
                        
                        logger.info(`Updated marketplace for ${order.items.length} items in order ${order.order_id}`);
                    }
                }
            } catch (orderError) {
                failedUpdates++;
                logger.error(`Error updating order ${order._id}: ${orderError.message}`);
            }
        }
        
        // Report results
        logger.info('Order marketplace fix completed');
        logger.info(`Updated ${etsyCount} Etsy orders`);
        logger.info(`Updated ${shopifyCount} Shopify orders`);
        
        if (unidentifiedCount > 0) {
            logger.warn(`Could not determine marketplace for ${unidentifiedCount} orders`);
        }
        
        if (failedUpdates > 0) {
            logger.error(`Failed to update ${failedUpdates} orders due to errors`);
        }
        
        mongoose.disconnect();
        
    } catch (error) {
        logger.error('Error fixing order marketplace fields:', error);
        mongoose.disconnect();
        process.exit(1);
    }
}

// Run the script
fixOrderMarketplaceFields();