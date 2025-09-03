#!/usr/bin/env node
const dotenv = require('@dotenvx/dotenvx');
dotenv.config();
const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('../config/database');
const Order = require('../models/order');
const shopifyHelpers = require('../utils/shopify-helpers');

async function syncOrder(order, client) {
	let shopifyId = null;
	if (order.marketplace_specific_id) {
		const parts = String(order.marketplace_specific_id).split('/');
		shopifyId = parts[parts.length - 1];
	} else if (order.order_id && String(order.order_id).startsWith('shopify-')) {
		shopifyId = String(order.order_id).replace('shopify-', '');
	}

	if (!shopifyId) {
		console.warn('No Shopify numeric id found for order, skipping', order._id);
		return { ok: false, reason: 'no_shopify_id' };
	}

	try {
		const shopifyOrder = await shopifyHelpers.withRetries(() => client.order.get(shopifyId));

		// map items like the UI sync
		if (shopifyOrder.line_items && shopifyOrder.line_items.length > 0) {
			order.items = shopifyOrder.line_items.map(item => ({
				marketplace: 'shopify',
				line_item_id: item.id ? String(item.id) : undefined,
				product_id: item.product_id ? String(item.product_id) : undefined,
				variant_id: item.variant_id ? String(item.variant_id) : undefined,
				sku: item.sku || `SHOPIFY-${item.product_id}-${item.variant_id}`,
				quantity: item.quantity,
				is_digital: item.requires_shipping === false,
			}));
		} else if (shopifyOrder.lineItems && shopifyOrder.lineItems.nodes) {
			order.items = shopifyOrder.lineItems.nodes.map(node => ({
				marketplace: 'shopify',
				line_item_id: node.id ? String(node.id).split('/').pop() : undefined,
				product_id: node.variant?.product?.id
					? String(node.variant.product.id).split('/').pop()
					: undefined,
				variant_id: node.variant?.id ? String(node.variant.id).split('/').pop() : undefined,
				sku: node.variant?.sku || undefined,
				quantity: node.quantity,
				is_digital: node.requiresShipping === false || node.requires_shipping === false,
			}));
		}

		order.updateFromShopify(shopifyOrder);
		order.shopify_order_data = shopifyOrder;
		await order.save();
		return { ok: true };
	} catch (err) {
		console.error('Error syncing from Shopify API for', order.order_id, err.message);
		return { ok: false, reason: err.message };
	}
}

async function main() {
	const limit = parseInt(process.argv[2], 10) || 10;
	console.log(
		'Bulk-sync: resyncing up to',
		limit,
		'Shopify orders missing fulfillments or unfulfilled'
	);

	const query = {
		marketplace: 'shopify',
		'items.is_digital': { $ne: true },
		$or: [
			{ shopify_order_data: { $exists: false } },
			{ 'shopify_order_data.fulfillments.0': { $exists: false } },
			{ 'shopify_order_data.displayFulfillmentStatus': { $ne: 'fulfilled' } },
		],
	};

	const candidates = await Order.find(query).sort({ order_date: -1 }).limit(limit).exec();
	console.log('Found', candidates.length, 'candidates');
	if (candidates.length === 0) process.exit(0);

	const client = shopifyHelpers.getShopifyClient();
	let updated = 0;
	let skipped = 0;
	for (const o of candidates) {
		console.log('Syncing', o.order_id || o.shopify_order_number);
		const res = await syncOrder(o, client);
		if (res.ok) {
			updated++;
			console.log(' -> updated');
		} else {
			skipped++;
			console.log(' -> skipped:', res.reason);
		}
		// small delay to avoid bursting API
		await new Promise(r => setTimeout(r, 200));
	}

	console.log(`Bulk-sync complete. updated=${updated}, skipped=${skipped}`);
	process.exit(0);
}

main().catch(err => {
	console.error('Fatal error in bulk-sync script:', err);
	process.exit(2);
});
