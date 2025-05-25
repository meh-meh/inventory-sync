//TODO: Cancelled orders shouldn't show as unshipped
//TODO: Order page state should persist when navigating back to the page

/**
 * Order management routes and API endpoints
 * Handles display and synchronization of order data from Etsy and Shopify
 * @module routes/orders
 */
const express = require('express');
const router = express.Router();
const Order = require('../models/order');
const getShopId = require('../utils/etsy-helpers').getShopId;
const fetch = require('node-fetch');
const { etsyRequest } = require('../utils/etsy-request-pool');

// Orders Management Routes
/**
 * Display order details for a specific order
 * Searches by order_id, receipt_id, or shopify_order_number
 * @route GET /orders/:id
 * @param {Object} req - Express request object with order ID parameter
 * @param {Object} res - Express response object
 */
router.get('/:id', async (req, res) => {
	try {
		// First try to find by order_id (new schema)
		const idParam = req.params.id;
		let order = await Order.findOne({ order_id: idParam })
			.maxTimeMS(10000)
			.lean({ virtuals: true });

		// If not found, try to find by receipt_id (old Etsy schema)
		if (!order) {
			order = await Order.findOne({ receipt_id: idParam })
				.maxTimeMS(10000)
				.lean({ virtuals: true });
		}

		// If still not found, try to find by Shopify order number
		if (!order) {
			order = await Order.findOne({ shopify_order_number: idParam })
				.maxTimeMS(10000)
				.lean({ virtuals: true });
		}

		if (!order) {
			req.flash('error', 'Order not found');
			// Preserve filter on redirect
			const redirectUrl = req.query.marketplace
				? `/orders?marketplace=${req.query.marketplace}`
				: '/orders';
			return res.redirect(redirectUrl);
		}

		res.render('order-details', {
			order,
			activeMarketplace: req.query.marketplace || 'all',
			activePage: 'orders', // Add activePage
		});
	} catch (error) {
		console.error('Error fetching order details:', error);
		req.flash('error', 'Error loading order details');
		// Redirect back to the orders list, preserving the filter if possible
		const redirectUrl = req.query.marketplace
			? `/orders?marketplace=${req.query.marketplace}`
			: '/orders';
		res.redirect(redirectUrl);
	}
});

/**
 * Display list of all orders with filtering by marketplace
 * @route GET /orders
 * @param {Object} req - Express request object with optional marketplace query parameter
 * @param {Object} res - Express response object
 */
router.get('/', async (req, res) => {
	try {
		const marketplace = req.query.marketplace || 'all';

		// Define base queries
		let unshippedQuery = {
			status: 'unshipped',
			items: { $exists: true, $ne: [] },
			'items.is_digital': false,
		};
		let shippedQuery = {
			status: 'shipped',
			items: { $exists: true, $ne: [] },
			'items.is_digital': false,
			// only show last 30 days of shipped orders. check order_date if shipped_date is not available
			$or: [
				{
					shipped_date: {
						$gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
						$ne: null,
					},
				},
				{
					order_date: {
						$gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
					},
				},
			],
		};
		let cancelledQuery = {}; // Defined below based on marketplace

		// Adjust queries based on marketplace filter
		if (marketplace === 'etsy') {
			unshippedQuery.$or = [
				{ marketplace: 'etsy' },
				{ receipt_id: { $exists: true, $ne: null }, marketplace: { $exists: false } },
			];
			shippedQuery.$or = [
				{ marketplace: 'etsy' },
				{ receipt_id: { $exists: true, $ne: null }, marketplace: { $exists: false } },
			];
			cancelledQuery = {
				$or: [
					{
						marketplace: 'etsy',
						'etsy_order_data.status': 'Canceled',
						order_date: {
							$gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
						},
					},
					{
						receipt_id: { $exists: true, $ne: null },
						marketplace: { $exists: false },
						'etsy_order_data.status': 'Canceled',
						order_date: {
							$gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
						},
					},
				],
				items: { $exists: true, $ne: [] },
				'items.is_digital': false,
			};
		} else if (marketplace === 'shopify') {
			unshippedQuery.$or = [
				{ marketplace: 'shopify' },
				{
					shopify_order_number: { $exists: true, $ne: null },
					marketplace: { $exists: false },
				},
			];
			shippedQuery.$or = [
				{ marketplace: 'shopify' },
				{
					shopify_order_number: { $exists: true, $ne: null },
					marketplace: { $exists: false },
				},
			];
			cancelledQuery = {
				$or: [
					{
						marketplace: 'shopify',
						'shopify_order_data.cancelled_at': { $ne: null },
					},
					{
						shopify_order_number: { $exists: true, $ne: null },
						marketplace: { $exists: false },
						'shopify_order_data.cancelled_at': { $ne: null },
					},
				],
				items: { $exists: true, $ne: [] },
				'items.is_digital': false,
			};
		} else {
			// All marketplaces - cancelledQuery needs both Etsy and Shopify conditions
			cancelledQuery = {
				$or: [
					{
						marketplace: 'etsy',
						'etsy_order_data.status': 'Canceled',
						order_date: {
							$gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
						},
					},
					{
						receipt_id: { $exists: true, $ne: null },
						marketplace: { $exists: false },
						'etsy_order_data.status': 'Canceled',
						order_date: {
							$gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
						},
					},
					{
						marketplace: 'shopify',
						'shopify_order_data.cancelled_at': { $ne: null },
					},
					{
						shopify_order_number: { $exists: true, $ne: null },
						marketplace: { $exists: false },
						'shopify_order_data.cancelled_at': { $ne: null },
					},
				],
				items: { $exists: true, $ne: [] },
				'items.is_digital': false,
			};
		}

		// Fetch orders and counts
		const [
			unshippedOrders,
			recentShippedOrders,
			cancelledOrders,
			totalEtsyCount,
			totalShopifyCount,
		] = await Promise.all([
			Order.find(unshippedQuery).sort({ order_date: -1 }).lean({ virtuals: true }),
			Order.find(shippedQuery).sort({ shipped_date: -1 }).lean({ virtuals: true }), // Limit recent shipped
			Order.find(cancelledQuery).sort({ order_date: -1 }).lean({ virtuals: true }), // Limit recent cancelled
			Order.countDocuments({
				$or: [
					{ marketplace: 'etsy' },
					{ receipt_id: { $exists: true, $ne: null }, marketplace: { $exists: false } },
				],
			}),
			Order.countDocuments({
				$or: [
					{ marketplace: 'shopify' },
					{
						shopify_order_number: { $exists: true, $ne: null },
						marketplace: { $exists: false },
					},
				],
			}),
		]);

		// Construct counts object for the view
		const counts = {
			etsy: totalEtsyCount,
			shopify: totalShopifyCount,
			total: totalEtsyCount + totalShopifyCount,
		};

		res.render('orders', {
			unshippedOrders,
			recentShippedOrders,
			cancelledOrders,
			counts, // Pass the counts object
			activeMarketplace: marketplace,
			syncStatus: req.query.syncStatus, // Pass sync status from query param
			activePage: 'orders', // Add activePage
		});
	} catch (error) {
		console.error('Error fetching orders:', error);
		req.flash('error', 'Error loading orders');
		res.status(500).redirect('/');
	}
});

// Orders API endpoints
/**
 * Sync Etsy order status with the Etsy API
 * Updates order details, shipping status, and item digital status
 * @route POST /orders/:id/sync-status
 * @param {Object} req - Express request object with order ID parameter
 * @param {Object} res - Express response object
 * @returns {Object} JSON response with success status or error
 */
router.post('/:id/sync-status', async (req, res) => {
	try {
		// Find the order using receipt_id and ensure it's an Etsy order
		const order = await Order.findOne({
			receipt_id: req.params.id,
			marketplace: 'etsy',
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
				Authorization: `Bearer ${tokenData.access_token}`,
			},
		};

		const response = await etsyRequest(
			() =>
				fetch(
					`https://openapi.etsy.com/v3/application/shops/${shop_id}/receipts/${order.receipt_id}`,
					requestOptions
				),
			{ endpoint: '/receipts/:id', method: 'GET', receipt_id: order.receipt_id }
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
					is_digital: transaction.is_digital || false,
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
/**
 * Sync Shopify order status with the Shopify API
 * Updates order details, shipping status, and item digital status
 * @route POST /orders/:id/sync-shopify-status
 * @param {Object} req - Express request object with order ID parameter
 * @param {Object} res - Express response object
 * @returns {Object} JSON response with success status or error
 */
router.post('/:id/sync-shopify-status', async (req, res) => {
	try {
		// Find the order using order_id or shopify_order_number
		const idParam = req.params.id;
		let order = await Order.findOne({
			$or: [{ order_id: idParam }, { shopify_order_number: idParam }],
			marketplace: 'shopify',
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
					is_digital: item.requires_shipping === false,
				}));
			}

			// Update order data
			order.updateFromShopify(shopifyOrder);
			order.shopify_order_data = shopifyOrder;
			await order.save();

			res.json({ success: true });
		} catch (shopifyError) {
			console.error('Shopify API Error:', shopifyError);
			res.status(500).json({
				error: `Error fetching from Shopify API: ${shopifyError.message}`,
			});
		}
	} catch (error) {
		console.error('Error syncing Shopify order status:', error);
		res.status(500).json({ error: 'Error syncing Shopify order status' });
	}
});

/**
 * Bulk fix order statuses from stored raw data
 * Updates order items, shipping status, and dates based on stored API data
 * @route POST /orders/fix-statuses
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Object} JSON response with success status and count of fixed orders
 */
router.post('/fix-statuses', async (req, res) => {
	try {
		const orders = await Order.find({
			'items.is_digital': { $ne: true }, // Only process orders with physical items
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
						is_digital: transaction.is_digital || false,
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
				if (
					order.etsy_order_data.is_shipped &&
					order.etsy_order_data.shipments &&
					order.etsy_order_data.shipments.length > 0 &&
					order.etsy_order_data.shipments[0].shipment_notification_timestamp
				) {
					const etsyShipDate = new Date(
						order.etsy_order_data.shipments[0].shipment_notification_timestamp * 1000
					);
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
			message: `Fixed ${fixedCount} order statuses`,
		});
	} catch (error) {
		console.error('Error fixing order statuses:', error);
		res.status(500).json({ error: 'Error fixing order statuses' });
	}
});

module.exports = router;
