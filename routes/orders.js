const express = require('express');
const router = express.Router();
const Order = require('../models/order');
const getShopId = require('../utils/etsy-helpers').getShopId;
const fetch = require('node-fetch');

// Orders Management Routes
router.get('/:id', async (req, res) => {
    try {
        // First try to find by order_id (new schema)
        const idParam = req.params.id;
        let order = await Order.findOne({ order_id: idParam });
        
        // If not found, try to find by receipt_id (old Etsy schema)
        if (!order) {
            order = await Order.findOne({ receipt_id: idParam });
        }
        
        // If still not found, try to find by Shopify order number
        if (!order) {
            order = await Order.findOne({ shopify_order_number: idParam });
        }
        
        if (!order) {
            req.flash('error', 'Order not found');
            return res.redirect('/orders');
        }
        
        res.render('order-details', { order });
    } catch (error) {
        console.error('Error fetching order details:', error);
        req.flash('error', 'Error loading order details');
        res.redirect('/orders');
    }
});

router.get('/', async (req, res) => {
    try {
        const marketplace = req.query.marketplace || 'all';
        const threeWeeksAgo = new Date();
        threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);
        
        // Build base queries with marketplace filter
        let marketplaceFilter = {};
        if (marketplace === 'etsy') {
            // Include orders explicitly marked as etsy OR that have etsy-specific fields
            marketplaceFilter = {
                $or: [
                    { marketplace: 'etsy' },
                    { 
                        receipt_id: { $exists: true, $ne: null },
                        marketplace: { $exists: false }  // Orders without marketplace field
                    }
                ]
            };
        } else if (marketplace === 'shopify') {
            // Include orders explicitly marked as shopify OR that have shopify-specific fields
            marketplaceFilter = {
                $or: [
                    { marketplace: 'shopify' },
                    {
                        shopify_order_number: { $exists: true, $ne: null },
                        marketplace: { $exists: false }  // Orders without marketplace field
                    }
                ]
            };
        }
        
        // Queries for each order category
        let unshippedQuery = {
            ...marketplaceFilter,
            status: 'unshipped',
            items: { $exists: true, $ne: [] },
            'items.is_digital': false
        };
        
        let shippedQuery = {
            ...marketplaceFilter,
            status: 'shipped',
            items: { $exists: true, $ne: [] },
            'items.is_digital': false,
            shipped_date: { 
                $gte: threeWeeksAgo,
                $ne: null 
            }
        };
        
        let cancelledQuery = {};
        if (marketplace === 'etsy') {
            cancelledQuery = {
                $or: [
                    { 
                        marketplace: 'etsy',
                        'etsy_order_data.status': 'Canceled'
                    },
                    {
                        receipt_id: { $exists: true, $ne: null },
                        marketplace: { $exists: false },
                        'etsy_order_data.status': 'Canceled'
                    }
                ],
                items: { $exists: true, $ne: [] },
                'items.is_digital': false
            };
        } else if (marketplace === 'shopify') {
            cancelledQuery = {
                $or: [
                    {
                        marketplace: 'shopify',
                        'shopify_order_data.cancelled_at': { $ne: null }
                    },
                    {
                        shopify_order_number: { $exists: true, $ne: null },
                        marketplace: { $exists: false },
                        'shopify_order_data.cancelled_at': { $ne: null }
                    }
                ],
                items: { $exists: true, $ne: [] },
                'items.is_digital': false
            };
        } else {
            // All marketplaces
            cancelledQuery = {
                $or: [
                    { 
                        marketplace: 'etsy',
                        'etsy_order_data.status': 'Canceled'
                    },
                    {
                        receipt_id: { $exists: true, $ne: null },
                        marketplace: { $exists: false },
                        'etsy_order_data.status': 'Canceled'
                    },
                    {
                        marketplace: 'shopify',
                        'shopify_order_data.cancelled_at': { $ne: null }
                    },
                    {
                        shopify_order_number: { $exists: true, $ne: null },
                        marketplace: { $exists: false },
                        'shopify_order_data.cancelled_at': { $ne: null }
                    }
                ],
                items: { $exists: true, $ne: [] },
                'items.is_digital': false
            };
        }

        // Update how we count orders by marketplace to include those without marketplace field
        const etsyFilter = {
            $or: [
                { marketplace: 'etsy' },
                { 
                    receipt_id: { $exists: true, $ne: null },
                    marketplace: { $exists: false }
                }
            ]
        };
        
        const shopifyFilter = {
            $or: [
                { marketplace: 'shopify' },
                {
                    shopify_order_number: { $exists: true, $ne: null }, 
                    marketplace: { $exists: false }
                }
            ]
        };

        const [unshippedOrders, recentShippedOrders, cancelledOrders, etsyCount, shopifyCount, totalCount] = await Promise.all([
            // Unshipped orders
            Order.aggregate([
                { $match: unshippedQuery },
                { $sort: { order_date: -1 } }
            ]),
            
            // Recently shipped orders
            Order.aggregate([
                { $match: shippedQuery },
                { $sort: { shipped_date: -1 } }
            ]),
            
            // Cancelled orders
            Order.aggregate([
                { $match: cancelledQuery },
                { $sort: { order_date: -1 } }
            ]),
            
            // Count for Etsy orders (including those without explicit marketplace)
            Order.countDocuments(etsyFilter),
            
            // Count for Shopify orders (including those without explicit marketplace)
            Order.countDocuments(shopifyFilter),
            
            // Total count
            Order.countDocuments()
        ]);

        // Before returning orders, add missing marketplace field based on order properties
        const processOrdersWithMissingMarketplace = (orders) => {
            return orders.map(order => {
                if (!order.marketplace) {
                    if (order.receipt_id) {
                        order.marketplace = 'etsy';
                    } else if (order.shopify_order_number) {
                        order.marketplace = 'shopify';
                    }
                }
                return order;
            });
        };

        res.render('orders', { 
            unshippedOrders: processOrdersWithMissingMarketplace(unshippedOrders), 
            recentShippedOrders: processOrdersWithMissingMarketplace(recentShippedOrders),
            cancelledOrders: processOrdersWithMissingMarketplace(cancelledOrders),
            syncStatus: req.query.synced,
            counts: {
                etsy: etsyCount,
                shopify: shopifyCount,
                total: totalCount
            },
            activeMarketplace: marketplace
        });
    } catch (error) {
        console.error('Error fetching orders:', error);
        req.flash('error', 'Error loading orders');
        res.status(500).redirect('/');
    }
});

// Orders API endpoints
router.post('/:id/sync-status', async (req, res) => {
    try {
        // Find the order using receipt_id and ensure it's an Etsy order
        const order = await Order.findOne({ 
            receipt_id: req.params.id,
            marketplace: 'etsy'
        });
        
        if (!order) {
            return res.status(404).json({ error: 'Etsy order not found' });
        }

        // Get fresh data from Etsy
        const tokenData = JSON.parse(process.env.TOKEN_DATA);
        const shop_id = await getShopId();
        
        const requestOptions = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ETSY_API_KEY,
                Authorization: `Bearer ${tokenData.access_token}`
            }
        };

        const response = await fetch(
            `https://openapi.etsy.com/v3/application/shops/${shop_id}/receipts/${order.receipt_id}`,
            requestOptions
        );

        if (response.ok) {
            const receipt = await response.json();
            
            // Update items with digital status
            if (receipt.transactions) {
                order.items = receipt.transactions.map(transaction => ({
                    marketplace: 'etsy',
                    receipt_id: receipt.receipt_id.toString(),
                    listing_id: transaction.listing_id.toString(),
                    sku: transaction.sku || 'NO_SKU',
                    quantity: transaction.quantity,
                    transaction_id: transaction.transaction_id.toString(),
                    is_digital: transaction.is_digital || false
                }));
            }
            
            order.updateFromEtsy(receipt);
            order.etsy_order_data = receipt;
            await order.save();
            res.json({ success: true });
        } else {
            console.error('Etsy API Error:', response.status, response.statusText);
            const errorData = await response.json();
            console.error(errorData);
            res.status(500).json({ error: 'Error fetching from Etsy API' });
        }
    } catch (error) {
        console.error('Error syncing order status:', error);
        res.status(500).json({ error: 'Error syncing order status' });
    }
});

// Sync Shopify order status
router.post('/:id/sync-shopify-status', async (req, res) => {
    try {
        // Find the order using order_id or shopify_order_number
        const idParam = req.params.id;
        let order = await Order.findOne({ 
            $or: [
                { order_id: idParam },
                { shopify_order_number: idParam }
            ],
            marketplace: 'shopify'
        });
        
        if (!order) {
            return res.status(404).json({ error: 'Shopify order not found' });
        }

        // Check for Shopify credentials
        if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.SHOPIFY_SHOP_NAME) {
            return res.status(500).json({ error: 'Shopify credentials not configured' });
        }
        
        try {
            // Use shopify-helpers to get the client instead of creating a new one
            const shopifyHelpers = require('../utils/shopify-helpers');
            const shopify = shopifyHelpers.getShopifyClient();
            
            // Extract Shopify order ID from our order_id format
            const shopifyOrderId = order.order_id.replace('shopify-', '');
            
            // Get fresh order data from Shopify with retry/error handling
            const shopifyOrder = await shopifyHelpers.withRetries(() => 
                shopify.order.get(shopifyOrderId)
            );
            
            // Update order items if available
            if (shopifyOrder.line_items && shopifyOrder.line_items.length > 0) {
                order.items = shopifyOrder.line_items.map(item => ({
                    marketplace: 'shopify',
                    line_item_id: item.id?.toString(),
                    product_id: item.product_id?.toString(),
                    variant_id: item.variant_id?.toString(),
                    sku: item.sku || `SHOPIFY-${item.product_id}-${item.variant_id}`,
                    quantity: item.quantity,
                    is_digital: item.requires_shipping === false
                }));
            }
            
            // Update order data
            order.updateFromShopify(shopifyOrder);
            order.shopify_order_data = shopifyOrder;
            await order.save();
            
            res.json({ success: true });
        } catch (shopifyError) {
            console.error('Shopify API Error:', shopifyError);
            res.status(500).json({ error: `Error fetching from Shopify API: ${shopifyError.message}` });
        }
    } catch (error) {
        console.error('Error syncing Shopify order status:', error);
        res.status(500).json({ error: 'Error syncing Shopify order status' });
    }
});

router.post('/fix-statuses', async (req, res) => {
    try {
        const orders = await Order.find({
            'items.is_digital': { $ne: true }  // Only process orders with physical items
        });
        let fixedCount = 0;
        
        for (const order of orders) {
            if (order.etsy_order_data) {
                let needsUpdate = false;
                
                // Update items with digital status
                if (order.etsy_order_data.transactions) {
                    order.items = order.etsy_order_data.transactions.map(transaction => ({
                        marketplace: 'etsy',
                        receipt_id: order.etsy_order_data.receipt_id.toString(),
                        listing_id: transaction.listing_id.toString(),
                        sku: transaction.sku || 'NO_SKU',
                        quantity: transaction.quantity,
                        transaction_id: transaction.transaction_id.toString(),
                        is_digital: transaction.is_digital || false
                    }));
                    needsUpdate = true;
                }
                
                // Check shipping status
                if (order.etsy_order_data.is_shipped !== order.etsy_is_shipped) {
                    order.etsy_is_shipped = order.etsy_order_data.is_shipped;
                    order.status = order.etsy_is_shipped ? 'shipped' : 'unshipped';
                    needsUpdate = true;
                }
                
                // Check shipping date
                if (order.etsy_order_data.is_shipped && 
                    order.etsy_order_data.shipments && 
                    order.etsy_order_data.shipments.length > 0 && 
                    order.etsy_order_data.shipments[0].shipment_notification_timestamp) {
                    const etsyShipDate = new Date(order.etsy_order_data.shipments[0].shipment_notification_timestamp * 1000);
                    order.shipped_date = etsyShipDate;
                    needsUpdate = true;
                }

                if (needsUpdate) {
                    await order.save();
                    fixedCount++;
                }
            }
        }
        
        res.json({ 
            success: true, 
            message: `Fixed ${fixedCount} order statuses` 
        });
    } catch (error) {
        console.error('Error fixing order statuses:', error);
        res.status(500).json({ error: 'Error fixing order statuses' });
    }
});

module.exports = router;