#!/usr/bin/env node
const dotenv = require('@dotenvx/dotenvx');
dotenv.config();
const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('../config/database');
const Order = require('../models/order');
const shopifyHelpers = require('../utils/shopify-helpers');

async function main() {
	const id = process.argv[2];
	if (!id) {
		console.error('Usage: node scripts/sync-single-shopify.js <order_id|shopify_order_number>');
		process.exit(2);
	}

	const order = await Order.findOne({
		$or: [{ order_id: id }, { shopify_order_number: id }],
		marketplace: 'shopify',
	});

	if (!order) {
		console.error('Order not found for', id);
		process.exit(3);
	}

	console.log('Found order:', order.order_id || order.shopify_order_number);
	const client = shopifyHelpers.getShopifyClient();

	let shopifyId = null;
	if (order.marketplace_specific_id) {
		const parts = String(order.marketplace_specific_id).split('/');
		shopifyId = parts[parts.length - 1];
	} else if (order.order_id && String(order.order_id).startsWith('shopify-')) {
		shopifyId = String(order.order_id).replace('shopify-', '');
	}

	if (!shopifyId) {
		console.error('No Shopify numeric id found for order, skipping', order._id);
		process.exit(4);
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

		console.log('Updated order. status =', order.status, 'shipped_date =', order.shipped_date);
		process.exit(0);
	} catch (err) {
		console.error('Error syncing from Shopify API:', err);
		process.exit(5);
	}
}

main();
