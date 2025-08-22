const express = require('express');
const router = express.Router();
const Order = require('../models/order');

// Debug endpoint for the backfill script
// Returns counts and a small sample of orders that the backfill would consider
router.get('/backfill-stale-orders', async (req, res) => {
	try {
		const AUTO_SYNC_HOURS = parseInt(process.env.AUTO_SYNC_INTERVAL || '24', 10);
		const cutoff = new Date(Date.now() - AUTO_SYNC_HOURS * 60 * 60 * 1000);

		const etsyQuery = {
			'items.is_digital': { $ne: true },
			status: { $ne: 'shipped' },
			$and: [
				{
					$or: [
						{ marketplace: 'etsy' },
						// Only consider documents with a numeric receipt_id (Etsy receipts
						// are numeric); this mirrors the runtime numeric check.
						{ receipt_id: { $exists: true, $ne: null, $regex: '^[0-9]+$' } },
					],
				},
				{
					$or: [
						{ last_etsy_sync: { $lt: cutoff } },
						{ last_etsy_sync: { $exists: false } },
						{ last_etsy_sync: null },
					],
				},
			],
		};

		const shopifyQuery = {
			'items.is_digital': { $ne: true },
			$and: [
				{
					$or: [
						{ marketplace: 'shopify' },
						{ shopify_order_number: { $exists: true, $ne: null } },
						// Some records identify Shopify orders by order_id like 'shopify-123'
						{ order_id: { $regex: '^shopify-' } },
					],
				},
				{
					$or: [
						{ last_shopify_sync: { $lt: cutoff } },
						{ last_shopify_sync: { $exists: false } },
						{ last_shopify_sync: null },
					],
				},
			],
		};

		// Base queries that mirror marketplace detection but do not include the "stale" cutoff
		// These help show the total pool of Etsy/Shopify orders (shouldn't be 0).
		const etsyBaseQuery = {
			'items.is_digital': { $ne: true },
			$or: [
				{ marketplace: 'etsy' },
				{ receipt_id: { $exists: true, $ne: null, $regex: '^[0-9]+$' } },
			],
		};

		const shopifyBaseQuery = {
			'items.is_digital': { $ne: true },
			$or: [
				{ marketplace: 'shopify' },
				{ shopify_order_number: { $exists: true, $ne: null } },
				{ order_id: { $regex: '^shopify-' } },
			],
		};

		const [
			etsyCount,
			shopifyCount,
			etsyTotalCount,
			shopifyTotalCount,
			etsyBaseSample,
			shopifyBaseSample,
			etsySample,
			shopifySample,
		] = await Promise.all([
			Order.countDocuments(etsyQuery),
			Order.countDocuments(shopifyQuery),
			Order.countDocuments(etsyBaseQuery),
			Order.countDocuments(shopifyBaseQuery),
			Order.find(etsyBaseQuery).sort({ order_date: 1 }).limit(10).lean({ virtuals: true }),
			Order.find(shopifyBaseQuery).sort({ order_date: 1 }).limit(10).lean({ virtuals: true }),
			Order.find(etsyQuery).sort({ order_date: 1 }).limit(10).lean({ virtuals: true }),
			Order.find(shopifyQuery).sort({ order_date: 1 }).limit(10).lean({ virtuals: true }),
		]);
		console.log(etsyCount);
		console.log(shopifyCount);
		const pick = doc => ({
			_id: doc._id,
			marketplace: doc.marketplace,
			// Prefer a human-friendly order identifier (shopify_order_number if present, else order_id)
			order_id: doc.order_id,
			receipt_id: doc.receipt_id,
			shopify_order_number: doc.shopify_order_number,
			order_number: doc.shopify_order_number || doc.order_id,
			status: doc.status,
			shopify_fulfillment_status: doc.shopify_fulfillment_status,
			last_shopify_sync: doc.last_shopify_sync,
			last_etsy_sync: doc.last_etsy_sync,
			order_date: doc.order_date,
		});

		res.json({
			AUTO_SYNC_HOURS,
			cutoff: cutoff.toISOString(),
			etsy: {
				count: etsyCount,
				total: etsyTotalCount,
				baseSample: etsyBaseSample.map(pick),
				sample: etsySample.map(pick),
			},
			shopify: {
				count: shopifyCount,
				total: shopifyTotalCount,
				baseSample: shopifyBaseSample.map(pick),
				sample: shopifySample.map(pick),
			},
			env: {
				ETSY_API_KEY: !!process.env.ETSY_API_KEY,
				SHOPIFY_ACCESS_TOKEN: !!process.env.SHOPIFY_ACCESS_TOKEN,
				SHOPIFY_SHOP_NAME: !!process.env.SHOPIFY_SHOP_NAME,
			},
		});
	} catch (err) {
		console.error('Debug backfill error', err);
		res.status(500).json({ error: err.message });
	}
});

module.exports = router;
