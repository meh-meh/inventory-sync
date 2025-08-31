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
const Product = require('../models/product');
const getShopId = require('../utils/etsy-helpers').getShopId;
const fetch = require('node-fetch');
const { etsyRequest } = require('../utils/etsy-request-pool');

// Orders Management Routes

/**
 * Order views endpoint - supports multiple view options via ?view=<option>
 * Current options:
 *  - sku-needs: Aggregates SKUs from all open (unshipped) orders and shows quantities needed and Shopify availability
 */
router.get('/view', async (req, res) => {
	try {
		const view = req.query.view || 'default';

		if (view === 'sku-needs' || view === 'sku' || view === 'sku-day') {
			// Group needed quantities by order date (physical items only)
			const orders = await Order.find({
				status: 'unshipped',
				items: { $exists: true, $ne: [] },
				'items.is_digital': false,
			}).lean({ virtuals: true });

			// dateStr (YYYY-MM-DD) -> { sku -> needed }
			const dateBuckets = {};
			for (const o of orders) {
				if (!o.items) continue;
				const dt = o.order_date
					? new Date(o.order_date)
					: o.shipped_date
						? new Date(o.shipped_date)
						: new Date();
				// normalize to YYYY-MM-DD
				const dateStr = dt.toISOString().slice(0, 10);

				if (!dateBuckets[dateStr]) dateBuckets[dateStr] = {};
				const bucket = dateBuckets[dateStr];

				for (const it of o.items) {
					if (it.is_digital) continue;
					const sku = it.sku || 'NO_SKU';
					if (!bucket[sku]) bucket[sku] = { needed: 0 };
					bucket[sku].needed += Number(it.quantity) || 0;
				}
			}

			// Flatten all SKUs to fetch product info
			const allSkus = new Set();
			for (const d of Object.keys(dateBuckets)) {
				for (const s of Object.keys(dateBuckets[d])) allSkus.add(s);
			}

			const productInfoMap = {};
			try {
				const skuList = Array.from(allSkus);
				if (skuList.length > 0) {
					const products = await Product.find({ sku: { $in: skuList } }).lean();
					for (const p of products) {
						const sku = p.sku;
						const title = (p.shopify_data && p.shopify_data.title) || p.name || '';
						let image = null;
						if (
							p.shopify_data &&
							Array.isArray(p.shopify_data.images) &&
							p.shopify_data.images.length > 0
						) {
							image = p.shopify_data.images[0].url;
						} else if (p.raw_shopify_data && p.raw_shopify_data.product) {
							const rp = p.raw_shopify_data.product;
							try {
								if (
									rp.images &&
									rp.images.edges &&
									rp.images.edges.length > 0 &&
									rp.images.edges[0].node &&
									rp.images.edges[0].node.originalSrc
								) {
									image = rp.images.edges[0].node.originalSrc;
								}
							} catch {
								image = null;
							}
						}

						let available = null;
						if (
							p.shopify_data &&
							typeof p.shopify_data.inventory_quantity === 'number'
						) {
							available = p.shopify_data.inventory_quantity;
						} else if (typeof p.quantity_available === 'number') {
							available = p.quantity_available;
						} else if (typeof p.quantity_on_hand === 'number') {
							available = p.quantity_on_hand - (p.quantity_committed || 0);
						}

						productInfoMap[sku] = { title, image, available };
					}
				}
			} catch (dbErr) {
				console.error('Error fetching product data from DB for SKU view:', dbErr);
			}

			// Build per-date rows and support two pagination modes:
			// - sku-needs (default): pagination over flattened SKU list
			// - sku-day: pagination over date groups (no day is split across pages)
			const sortParam = String(req.query.sort || 'needed_desc');
			const sortFns = {
				needed_desc: (a, b) => b.needed - a.needed,
				needed_asc: (a, b) => a.needed - b.needed,
				available_desc: (a, b) => (b.available || 0) - (a.available || 0),
				available_asc: (a, b) => (a.available || 0) - (b.available || 0),
				sku_asc: (a, b) => String(a.sku).localeCompare(String(b.sku)),
				sku_desc: (a, b) => String(b.sku).localeCompare(String(a.sku)),
			};

			// sort dates ascending so oldest date at top by default
			const dateKeys = Object.keys(dateBuckets).sort((a, b) => new Date(a) - new Date(b));

			const flatRows = [];
			for (const dateStr of dateKeys) {
				const bucket = dateBuckets[dateStr];
				const inner = [];
				for (const sku of Object.keys(bucket)) {
					inner.push({
						sku,
						title: productInfoMap[sku]?.title || '',
						image: productInfoMap[sku]?.image || null,
						needed: bucket[sku].needed,
						available: productInfoMap[sku]?.available ?? null,
						date: dateStr,
					});
				}

				inner.sort(sortFns[sortParam] || sortFns.needed_desc);

				for (const r of inner) flatRows.push(r);
			}

			// If user requested the 'sku-day' view, paginate by date groups (do not split a day)
			if (view === 'sku-day') {
				// total number of date groups
				const totalDates = dateKeys.length;
				const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
				// Treat pageSize as number of dates per page; keep limits reasonable
				const pageSize = Math.max(
					1,
					Math.min(500, parseInt(req.query.pageSize || '10', 10) || 10)
				);
				const totalPages = Math.max(1, Math.ceil(totalDates / pageSize));
				const currentPage = Math.min(page, totalPages);
				const startIndex = (currentPage - 1) * pageSize;
				const pagedDateKeys = dateKeys.slice(startIndex, startIndex + pageSize);

				const groupedDays = [];
				for (const dateStr of pagedDateKeys) {
					const bucket = dateBuckets[dateStr] || {};
					const inner = [];
					for (const sku of Object.keys(bucket)) {
						inner.push({
							sku,
							title: productInfoMap[sku]?.title || '',
							image: productInfoMap[sku]?.image || null,
							needed: bucket[sku].needed,
							available: productInfoMap[sku]?.available ?? null,
							date: dateStr,
						});
					}
					inner.sort(sortFns[sortParam] || sortFns.needed_desc);
					const totalNeeded = inner.reduce((s, it) => s + (it.needed || 0), 0);
					const label = new Date(dateStr + 'T00:00:00Z').toDateString();
					groupedDays.push({ date: dateStr, label, totalNeeded, rows: inner });
				}

				return res.render('orders-sku-view', {
					groupedDays,
					activePage: 'orders',
					activeMarketplace: req.query.marketplace || 'all',
					view: 'sku-day',
					pagination: {
						page: currentPage,
						pageSize,
						total: totalDates,
						totalPages,
						sort: sortParam,
						byDate: true,
					},
				});
			}

			// sku-needs: aggregate across all dates (sum needed per SKU) and paginate item-level
			const skuMap = {};
			for (const r of flatRows) {
				if (!skuMap[r.sku])
					skuMap[r.sku] = {
						sku: r.sku,
						title: r.title,
						image: r.image,
						needed: 0,
						available: r.available ?? null,
					};
				skuMap[r.sku].needed += r.needed || 0;
				if (r.available != null) skuMap[r.sku].available = r.available;
			}

			let rowsArr = Object.values(skuMap);
			rowsArr.sort(sortFns[sortParam] || sortFns.needed_desc);

			const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
			const pageSize = Math.max(
				1,
				Math.min(500, parseInt(req.query.pageSize || '50', 10) || 50)
			);
			const total = rowsArr.length;
			const totalPages = Math.max(1, Math.ceil(total / pageSize));
			const currentPage = Math.min(page, totalPages);
			const startIndex = (currentPage - 1) * pageSize;
			const pagedRows = rowsArr.slice(startIndex, startIndex + pageSize);

			return res.render('orders-sku-view', {
				rows: pagedRows,
				activePage: 'orders',
				activeMarketplace: req.query.marketplace || 'all',
				view: 'sku-needs',
				pagination: {
					page: currentPage,
					pageSize,
					total,
					totalPages,
					sort: sortParam,
				},
			});
		}

		// Unknown view - fallback to orders list
		return res.redirect('/orders');
	} catch (error) {
		console.error('Error rendering orders view:', error);
		req.flash('error', 'Error loading orders view');
		return res.redirect('/orders');
	}
});

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
						// order_date: {
						// 	$gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
						// },
					},
					{
						receipt_id: { $exists: true, $ne: null },
						marketplace: { $exists: false },
						'etsy_order_data.status': 'Canceled',
						// order_date: {
						// 	$gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
						// },
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
						// order_date: {
						// 	$gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
						// },
					},
					{
						receipt_id: { $exists: true, $ne: null },
						marketplace: { $exists: false },
						'etsy_order_data.status': 'Canceled',
						// order_date: {
						// 	$gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
						// },
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
