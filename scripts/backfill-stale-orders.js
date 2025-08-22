#!/usr/bin/env node
/*
 Backfill shipped_date for Etsy and Shopify orders whose last sync is older than
 the configured AUTO_SYNC_INTERVAL. Supports dry-run, batching, concurrency and
 stops when no updates are prepared or a consecutive-miss threshold is hit.

 Usage:
	node scripts/backfill-stale-orders.js --dry-run
	node scripts/backfill-stale-orders.js --batch=50 --concurrency=3
*/

const dotenv = require('@dotenvx/dotenvx');
dotenv.config();

const path = require('path');
process.chdir(path.join(__dirname, '..'));

require('../config/database');
const Order = require('../models/order');
const authService = require('../utils/auth-service');
const { etsyRequest } = require('../utils/etsy-request-pool');
const { getShopId, API_BASE_URL } = require('../utils/etsy-helpers');
const shopifyHelpers = require('../utils/shopify-helpers');
const fetch = require('node-fetch');

const DEFAULT_BATCH = 50;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_CONSECUTIVE_MISSES = 100;

const argv = require('minimist')(process.argv.slice(2));
const dryRun = !!argv['dry-run'] || !!argv.dry || process.env.DRY_RUN === 'true';
const batchSize = parseInt(argv.batch || argv.b || DEFAULT_BATCH, 10);
const concurrency = parseInt(argv.concurrency || argv.c || DEFAULT_CONCURRENCY, 10);
const maxConsecutiveMisses = parseInt(
	argv.maxMisses || argv.m || DEFAULT_MAX_CONSECUTIVE_MISSES,
	10
);

const AUTO_SYNC_HOURS = parseInt(process.env.AUTO_SYNC_INTERVAL || '24', 10);
const cutoff = new Date(Date.now() - AUTO_SYNC_HOURS * 60 * 60 * 1000);

// When running in dry-run mode we don't write back to DB, so maintain an
// in-memory set of processed order IDs to avoid reprocessing the same docs
// across loop iterations.
const processedIds = new Set();

function extractShippedDateFromReceipt(receipt) {
	try {
		const shipments = receipt.shipments || [];
		if (shipments.length > 0) {
			const s = shipments[0];
			if (s.shipment_notification_timestamp)
				return new Date(s.shipment_notification_timestamp * 1000);
			if (s.mail_date) return new Date(s.mail_date * 1000);
			if (s.shipped_timestamp) return new Date(s.shipped_timestamp * 1000);
			if (s.shipped_date) return new Date(s.shipped_date);
		}
		if (receipt.shipped_timestamp) return new Date(receipt.shipped_timestamp * 1000);
		if (receipt.mail_date) return new Date(receipt.mail_date * 1000);
		if (receipt.created_timestamp && receipt.is_shipped)
			return new Date(receipt.created_timestamp * 1000);
		return null;
	} catch (err) {
		console.warn('Failed to extract shipped date from receipt', err.message);
		return null;
	}
}

async function ensureAccessToken() {
	let token = authService.getAccessToken();
	if (!token) {
		try {
			await authService.refreshToken();
			token = authService.getAccessToken();
			if (!token) throw new Error('refresh did not yield token');
		} catch (err) {
			throw new Error(`Unable to obtain access token: ${err.message}`);
		}
	}
	return token;
}

async function processBatch() {
	// Etsy: consider orders by last_etsy_sync (no status filter)
	// IMPORTANT: avoid selecting Shopify orders that happen to have a receipt_id
	// (e.g. 'shopify-...') because the Etsy loop will skip non-numeric receipt_ids
	// and in dry-run those docs get added to `processedIds`, which then excludes
	// them from the Shopify pass. Only include the receipt_id branch for
	// documents that are not known to be from Shopify.
	const etsyQuery = {
		'items.is_digital': { $ne: true },
		// Only consider orders that are not already marked as shipped.
		status: { $ne: 'shipped' },
		$and: [
			{
				$or: [
					{ marketplace: 'etsy' },
					// Only consider documents with a receipt_id when the
					// marketplace is not 'shopify' to avoid cross-pollination.
					{ receipt_id: { $exists: true, $ne: null }, marketplace: { $ne: 'shopify' } },
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

	// Exclude already-seen IDs in dry-run so the script terminates instead of
	// repeatedly selecting the same candidates.
	if (dryRun && processedIds.size > 0) {
		etsyQuery._id = { $nin: Array.from(processedIds) };
	}
	const etsyOrders = await Order.find(etsyQuery).sort({ order_date: 1 }).limit(batchSize).exec();
	let etsyProcessed = 0;
	let etsyConsecutiveMisses = 0;
	let etsyHadUpdates = false;

	if (etsyOrders && etsyOrders.length > 0) {
		const shopId = await getShopId();
		if (!shopId) throw new Error('ETSY_SHOP_ID not configured or could not be fetched');

		const etsyOps = [];
		const chunks = [];
		for (let i = 0; i < etsyOrders.length; i += concurrency)
			chunks.push(etsyOrders.slice(i, i + concurrency));

		for (const chunk of chunks) {
			await Promise.all(
				chunk.map(async order => {
					try {
						await ensureAccessToken();
						const receiptId = order.receipt_id;
						if (!receiptId) {
							console.warn(
								'Order missing receipt_id, skipping (likely not an Etsy order)',
								order._id
							);
							etsyConsecutiveMisses++;
							return;
						}
						const receiptIdStr = String(receiptId);
						if (!/^[0-9]+$/.test(receiptIdStr)) {
							console.warn(
								`receipt_id '${receiptIdStr}' does not look numeric; skipping`
							);
							etsyConsecutiveMisses++;
							return;
						}

						const url = `${API_BASE_URL}/application/shops/${shopId}/receipts/${receiptIdStr}`;
						const response = await etsyRequest(
							() =>
								fetch(url, {
									method: 'GET',
									headers: {
										'x-api-key': process.env.ETSY_API_KEY,
										Authorization: `Bearer ${authService.getAccessToken()}`,
										'Content-Type': 'application/json',
									},
								}),
							{ endpoint: '/receipts/:id', method: 'GET', receipt_id: receiptIdStr }
						);

						if (!response.ok) {
							console.warn(
								`Etsy API returned ${response.status} for receipt ${receiptIdStr}`
							);
							etsyConsecutiveMisses++;
							return;
						}

						const receipt = await response.json();
						const newShippedDate = extractShippedDateFromReceipt(receipt);
						const isCancelled =
							receipt.status && String(receipt.status).toLowerCase() === 'canceled';
						const isShipped = !!(receipt.is_shipped || newShippedDate);

						if (!isShipped && !isCancelled) etsyConsecutiveMisses++;
						else etsyConsecutiveMisses = 0;

						const update = {
							$set: {
								etsy_order_data: receipt,
								etsy_is_shipped: !!receipt.is_shipped,
								status: isCancelled
									? 'cancelled'
									: isShipped
										? 'shipped'
										: 'unshipped',
								last_etsy_sync: new Date(),
							},
						};
						if (isCancelled) update.$set.shipped_date = null;
						else if (newShippedDate) update.$set.shipped_date = newShippedDate;

						etsyOps.push({ updateOne: { filter: { _id: order._id }, update } });
						console.log(
							`Prepared update for Etsy order ${order.order_id || order.receipt_id} -> shipped_date=${newShippedDate}`
						);
					} catch (err) {
						console.error('Error processing Etsy order', order._id, err.message);
						etsyConsecutiveMisses++;
					}
				})
			);

			if (etsyConsecutiveMisses >= maxConsecutiveMisses) {
				console.log(
					`Reached ${etsyConsecutiveMisses} consecutive Etsy misses — stopping early.`
				);
				break;
			}
		}

		if (etsyOps.length > 0) {
			if (dryRun) console.log(`Dry-run: would execute ${etsyOps.length} Etsy updates`);
			else {
				const res = await Order.bulkWrite(etsyOps, { ordered: false });
				console.log(`Executed Etsy bulkWrite: ${JSON.stringify(res.result || res)}`);
			}
			etsyHadUpdates = etsyOps.length > 0;
		} else {
			console.log('No Etsy updates prepared for this batch.');
			etsyHadUpdates = false;
		}
		etsyProcessed = etsyOrders.length;
		if (dryRun && etsyOrders && etsyOrders.length > 0) {
			for (const o of etsyOrders) processedIds.add(String(o._id));
		}
	}

	// Shopify: consider orders by last_shopify_sync (no status filter)
	const shopifyQuery = {
		'items.is_digital': { $ne: true },
		$and: [
			{
				$or: [
					{ marketplace: 'shopify' },
					{ shopify_order_number: { $exists: true, $ne: null } },
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

	// Exclude already-seen IDs in dry-run so the script doesn't keep selecting
	// the same Shopify candidates across iterations.
	if (dryRun && processedIds.size > 0) {
		shopifyQuery._id = { $nin: Array.from(processedIds) };
	}

	const shopifyOrders = await Order.find(shopifyQuery)
		.sort({ order_date: 1 })
		.limit(batchSize)
		.exec();
	let shopifyProcessed = 0;
	let shopifyConsecutiveMisses = 0;
	let shopifyHadUpdates = false;

	if (shopifyOrders && shopifyOrders.length > 0) {
		const client = shopifyHelpers.getShopifyClient();
		const shopifyOps = [];
		const chunks = [];
		for (let i = 0; i < shopifyOrders.length; i += concurrency)
			chunks.push(shopifyOrders.slice(i, i + concurrency));

		for (const chunk of chunks) {
			await Promise.all(
				chunk.map(async order => {
					try {
						// Decide whether to use stored shopify_order_data or fetch live data.
						// Fetch live when there is no stored data, or when stored data has no
						// fulfillments and the display fulfillment status isn't 'fulfilled'.
						let shopifyData = order.shopify_order_data;
						let shouldFetchShopify = false;

						if (!shopifyData) {
							shouldFetchShopify = true;
						} else {
							const hasFulfillments =
								Array.isArray(shopifyData.fulfillments) &&
								shopifyData.fulfillments.length > 0;
							const displayStatus = String(
								shopifyData.displayFulfillmentStatus ||
									shopifyData.display_fulfillment_status ||
									shopifyData.displayFulfillmentStatus ||
									''
							).toLowerCase();
							if (!hasFulfillments && displayStatus !== 'fulfilled') {
								shouldFetchShopify = true;
							}
						}

						if (shouldFetchShopify) {
							let shopifyId = null;
							if (order.marketplace_specific_id) {
								const parts = String(order.marketplace_specific_id).split('/');
								shopifyId = parts[parts.length - 1];
							} else if (
								order.order_id &&
								String(order.order_id).startsWith('shopify-')
							) {
								shopifyId = String(order.order_id).replace('shopify-', '');
							}
							if (!shopifyId) {
								console.warn(
									'No Shopify numeric id found for order, skipping',
									order._id
								);
								shopifyConsecutiveMisses++;
								return;
							}

							try {
								console.log(
									`Fetching live Shopify data for ${order.order_id || order.shopify_order_number}`
								);
								shopifyData = await shopifyHelpers.withRetries(() =>
									client.order.get(shopifyId)
								);
							} catch (err) {
								console.warn(
									`Shopify API returned error for id ${shopifyId}: ${err.message}`
								);
								shopifyConsecutiveMisses++;
								return;
							}
						}

						let shippedDate = null;
						if (shopifyData.fulfillments && shopifyData.fulfillments.length > 0) {
							const dates = shopifyData.fulfillments
								.map(f => (f.created_at ? new Date(f.created_at).getTime() : null))
								.filter(Boolean);
							if (dates.length > 0) shippedDate = new Date(Math.min(...dates));
						}

						const isCancelled = !!shopifyData.cancelled_at;
						const isShipped =
							!!shippedDate ||
							(shopifyData.displayFulfillmentStatus &&
								shopifyData.displayFulfillmentStatus.toLowerCase() === 'fulfilled');

						if (!isShipped && !isCancelled) shopifyConsecutiveMisses++;
						else shopifyConsecutiveMisses = 0;

						const update = {
							$set: {
								shopify_order_data: shopifyData,
								shopify_fulfillment_status:
									shopifyData.displayFulfillmentStatus ||
									order.shopify_fulfillment_status,
								status: isCancelled
									? 'cancelled'
									: isShipped
										? 'shipped'
										: 'unshipped',
								last_shopify_sync: new Date(),
							},
						};

						// Mirror the per-order sync: include items mapping when Shopify provides line_items
						if (shopifyData.line_items && shopifyData.line_items.length > 0) {
							update.$set.items = shopifyData.line_items.map(item => ({
								marketplace: 'shopify',
								line_item_id: item.id ? String(item.id) : undefined,
								product_id: item.product_id ? String(item.product_id) : undefined,
								variant_id: item.variant_id ? String(item.variant_id) : undefined,
								sku: item.sku || `SHOPIFY-${item.product_id}-${item.variant_id}`,
								quantity: item.quantity,
								is_digital: item.requires_shipping === false,
							}));
						}
						if (isCancelled) update.$set.shipped_date = null;
						else if (shippedDate) update.$set.shipped_date = shippedDate;

						shopifyOps.push({ updateOne: { filter: { _id: order._id }, update } });
						console.log(
							`Prepared update for Shopify order ${order.order_id || order.shopify_order_number} -> shipped_date=${shippedDate}`
						);
					} catch (err) {
						console.error('Error processing Shopify order', order._id, err.message);
						shopifyConsecutiveMisses++;
					}
				})
			);

			if (shopifyConsecutiveMisses >= maxConsecutiveMisses) {
				console.log(
					`Reached ${shopifyConsecutiveMisses} consecutive Shopify misses — stopping early.`
				);
				break;
			}
		}

		if (shopifyOps.length > 0) {
			if (dryRun) console.log(`Dry-run: would execute ${shopifyOps.length} Shopify updates`);
			else {
				const res = await Order.bulkWrite(shopifyOps, { ordered: false });
				console.log(`Executed Shopify bulkWrite: ${JSON.stringify(res.result || res)}`);
			}
			shopifyHadUpdates = shopifyOps.length > 0;
		} else {
			console.log('No Shopify updates prepared for this batch.');
			shopifyHadUpdates = false;
		}
		shopifyProcessed = shopifyOrders.length;
		if (dryRun && shopifyOrders && shopifyOrders.length > 0) {
			for (const o of shopifyOrders) processedIds.add(String(o._id));
		}
	}

	const totalProcessed = etsyProcessed + shopifyProcessed;
	const totalConsecutiveMisses = Math.max(
		etsyConsecutiveMisses || 0,
		shopifyConsecutiveMisses || 0
	);
	const hadUpdates = etsyHadUpdates || shopifyHadUpdates;
	const done = totalProcessed === 0 || !hadUpdates;
	return {
		done,
		processed: totalProcessed,
		consecutiveMisses: totalConsecutiveMisses,
		hadUpdates,
	};
}

async function main() {
	console.log('Backfill stale orders -- starting');
	console.log(`AUTO_SYNC_INTERVAL hours: ${AUTO_SYNC_HOURS}, cutoff: ${cutoff.toISOString()}`);
	console.log(`Options: batchSize=${batchSize}, concurrency=${concurrency}, dryRun=${dryRun}`);

	let loop = 0;
	let totalProcessed = 0;
	while (true) {
		loop++;
		console.log(`Processing batch #${loop}...`);
		const { done, processed, consecutiveMisses } = await processBatch();
		if (done) {
			console.log('No more orders to process.');
			break;
		}
		totalProcessed += processed;
		if (consecutiveMisses && consecutiveMisses >= maxConsecutiveMisses) {
			console.log('Stopping due to consecutive misses threshold.');
			break;
		}
		await new Promise(r => setTimeout(r, 500));
	}

	console.log(`Finished backfill. Total orders scanned: ${totalProcessed}`);
	if (dryRun) console.log('Dry-run mode — no DB updates were applied.');
	process.exit(0);
}

main().catch(err => {
	console.error('Fatal error in backfill script:', err);
	process.exit(2);
});
