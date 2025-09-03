// TODO: Figure out why order sync doesn't update progress bar.

// filepath: c:\\Users\\Mat\\Documents\\Etsy_Inventory\\services\\shopify-sync-service.js
const Shopify = require('shopify-api-node');
const { Product, Order, Settings } = require('../models');
const { logger } = require('../utils/logger'); // Destructure logger
const shopifyHelpers = require('../utils/shopify-helpers');
const {
	initializeSyncStatus,
	updateSyncStatus,
	completeSyncStatus,
	getSyncStatus,
} = require('../utils/sync-status-manager');
const { performance } = require('perf_hooks');

const ORDER_SYNC_DAYS = parseInt(process.env.ORDER_SYNC_DAYS || '90', 10);
const BATCH_SIZE = parseInt(process.env.SHOPIFY_BATCH_SIZE || '30', 10); // Reverted to 30 from 50
const SHOPIFY_ORDER_GRAPHQL_BATCH_SIZE = parseInt(
	process.env.SHOPIFY_ORDER_GRAPHQL_BATCH_SIZE || '50',
	10
);
const SHOPIFY_REQUEST_DELAY_MS = 1500; // Reverted to 1500ms from 500ms

/**
 * Synchronizes Shopify products with the internal database
 * Fetches product data from Shopify, processes it, and updates the database
 * @param {string} syncId - The unique ID for this sync operation used for status tracking
 * @returns {Promise<void>}
 */
async function syncShopifyProducts(syncId) {
	const overallStartTime = performance.now();
	let newProducts = 0; // Renamed from newOrders
	let updatedProducts = 0; // Renamed from updatedOrders
	let knownTotalCount = 0; // To store the definitive total count once fetched
	let currentGraphqlLimits = null; // Variable to store limits from event

	try {
		initializeSyncStatus(syncId, 'shopify', 'products', {
			currentPhase: 'Initializing Shopify product sync',
		});

		const shopify = new Shopify({
			shopName: process.env.SHOPIFY_SHOP_NAME,
			accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
			apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
			timeout: 60000,
			autoLimit: true,
		});

		// Event listener for GraphQL call limits
		shopify.on('callGraphqlLimits', limits => {
			logger.info('Shopify callGraphqlLimits event (Products):', { syncId, limits });
			currentGraphqlLimits = limits; // Store the latest limits
		});

		updateSyncStatus(syncId, { currentPhase: 'Fetching Shopify products', progress: 5 });

		let allShopifyProducts = [];
		let paginationInfo = null;
		let hasNextPage = true;
		let processedProductCount = 0;

		const productFieldsFragment = `
            id
            legacyResourceId
            title
            handle
            status
            vendor
            productType
            createdAt
            updatedAt
            publishedAt
            tags
            options { id name values }
            images(first: 10) { edges { node { id originalSrc altText } } }
            variants(first: 50) {
                edges {
                    node {
                        id
                        legacyResourceId
                        sku
                        title
                        price
                        compareAtPrice
                        inventoryQuantity
                        inventoryPolicy
                        barcode
                        image { id originalSrc altText }
                        selectedOptions { name value }
                        weight
                        weightUnit
                    }
                }
                pageInfo { hasNextPage endCursor }
            }
        `;

		let nextDelayMs = SHOPIFY_REQUEST_DELAY_MS; // Default delay
		let previousQueryCost = 0; // To track the cost of the previous query
		while (hasNextPage) {
			const query =
				paginationInfo?.hasNextPage && paginationInfo?.endCursor
					? `query {
                    products(first: ${BATCH_SIZE}, after: "${paginationInfo.endCursor}") {
                        edges { node { ${productFieldsFragment} } }
                        pageInfo { hasNextPage endCursor }
                    }
                }`
					: `query {
                    products(first: ${BATCH_SIZE}) {
                        edges { node { ${productFieldsFragment} } }
                        pageInfo { hasNextPage endCursor }
                    }
                }`;

			const fetchStartTime = performance.now();
			const result = await shopify.graphql(query);
			const fetchEndTime = performance.now();
			logger.info(
				`[Perf] Shopify products GraphQL query took ${(fetchEndTime - fetchStartTime).toFixed(2)}ms`,
				{ syncId }
			);

			if (result.products?.edges) {
				const fetchedProducts = result.products.edges.map(edge => edge.node);
				allShopifyProducts.push(...fetchedProducts);
				paginationInfo = result.products.pageInfo;
				hasNextPage = paginationInfo.hasNextPage;

				let currentProgressTotal;
				if (!hasNextPage) {
					knownTotalCount = allShopifyProducts.length; // All products fetched, this is the true total
					currentProgressTotal = knownTotalCount;
				} else {
					// Still fetching, estimate total for progress display
					currentProgressTotal = allShopifyProducts.length + BATCH_SIZE; // Estimate: current + at least one more batch
				}

				updateSyncStatus(syncId, {
					syncCount: allShopifyProducts.length,
					totalCount: knownTotalCount || currentProgressTotal, // Use known total if available, else current estimate
					progress:
						10 +
						Math.min(
							60,
							Math.round((allShopifyProducts.length / currentProgressTotal) * 60)
						), // Cap fetching phase progress at 70%
					currentPhase: `Fetched ${allShopifyProducts.length} products...`,
				});
			} else {
				hasNextPage = false; // Stop fetching
				if (allShopifyProducts.length > 0 && !knownTotalCount) {
					knownTotalCount = allShopifyProducts.length; // If edges are null but we have products, this is the total
				}
				updateSyncStatus(syncId, {
					syncCount: allShopifyProducts.length,
					totalCount: knownTotalCount || allShopifyProducts.length,
					currentPhase: `Finished fetching products. Total: ${allShopifyProducts.length}.`,
				});
				logger.warn('Shopify products query returned no edges or unexpected structure.', {
					syncId,
					result,
				});
			}

			// Dynamic Rate Limiting
			const limitsToUse = currentGraphqlLimits || shopify.callLimits().GRAPHQL; // Prioritize event-driven limits
			if (limitsToUse) {
				const { remaining, current, max, restoreRate } = limitsToUse;

				// Average previous cost with current cost to estimate next call cost
				const actualQueryCost = current || 0; // Cost of the last query
				const queryCostForNextCall =
					actualQueryCost > 0
						? previousQueryCost > 0
							? (actualQueryCost + previousQueryCost) / 2
							: actualQueryCost
						: 50; // Estimate for next call
				previousQueryCost = actualQueryCost; // Update previous cost for next iteration

				logger.info(
					`GraphQL Call Limits (Products): Cost=${actualQueryCost}, Remaining=${remaining}, Max=${max}, RestoreRate=${restoreRate}/s (Using ${currentGraphqlLimits ? 'event data' : 'callLimits()'})`,
					{ syncId }
				);

				const targetRemaining = max / 2; // Target 50% of max available cost

				if (remaining < targetRemaining + queryCostForNextCall) {
					// We are below 50% or will be after the next call, so we need to slow down
					const pointsToRecover = targetRemaining + queryCostForNextCall - remaining;
					if (pointsToRecover > 0 && restoreRate > 0) {
						const calculatedWaitTimeSec = pointsToRecover / restoreRate;
						nextDelayMs = Math.max(
							Math.ceil(calculatedWaitTimeSec * 1000),
							100 // Minimum delay to avoid too frequent calls
						);
						logger.info(
							`Adjusting Shopify product sync speed. Remaining: ${remaining}, Target: ${targetRemaining}. Delaying for ${nextDelayMs}ms.`,
							{ syncId }
						);
					}
				} else if (
					remaining > targetRemaining + queryCostForNextCall * 2 &&
					nextDelayMs > 100
				) {
					// We have ample budget (more than 50% + 2 * next call cost), try to speed up slightly by reducing delay
					// but don't go below a minimum sensible delay (e.g., 50ms)
					nextDelayMs = Math.max(50, nextDelayMs / 2);
					logger.info(
						`Ample GraphQL budget (Products). Remaining: ${remaining}. Reducing delay to ${nextDelayMs}ms.`,
						{ syncId }
					);
				}
			} else {
				logger.warn(
					'GraphQL call limits not available from event or shopify.callLimits() for products. Using default delay.',
					{ syncId }
				);
			}

			if (hasNextPage) await shopifyHelpers.sleep(nextDelayMs);
		}

		knownTotalCount = allShopifyProducts.length; // Final actual count
		updateSyncStatus(syncId, {
			totalCount: knownTotalCount,
			syncCount: knownTotalCount,
			currentPhase: 'All Shopify products fetched',
			progress: 70,
		});

		if (allShopifyProducts.length > 0) {
			const bulkOps = [];
			const existingSkus = new Set(
				(
					await Product.find({ 'shopify_data.product_id': { $exists: true } })
						.select('sku')
						.lean()
				).map(p => p.sku)
			);

			for (let i = 0; i < allShopifyProducts.length; i++) {
				const productNode = allShopifyProducts[i];
				try {
					const shopifyProductId = productNode.legacyResourceId.toString();

					for (const variantEdge of productNode.variants.edges) {
						const variant = variantEdge.node;
						const sku =
							variant.sku ||
							`SHOPIFY-${shopifyProductId}-${variant.legacyResourceId.toString()}`;

						const productData = {
							sku,
							name:
								productNode.title +
								(variant.title !== 'Default Title' ? ` - ${variant.title}` : ''),
							description: '',
							price: parseFloat(variant.price),
							quantity_on_hand: variant.inventoryQuantity || 0,
							marketplace_data: {
								shopify: {
									product_id: shopifyProductId,
									variant_id: variant.legacyResourceId.toString(),
									title: productNode.title,
									variant_title: variant.title,
									status: productNode.status,
									vendor: productNode.vendor,
									product_type: productNode.productType,
									tags: productNode.tags,
									images: productNode.images.edges.map(imgEdge => ({
										url: imgEdge.node.originalSrc,
										alt: imgEdge.node.altText,
									})),
									variant_image: variant.image
										? {
												url: variant.image.originalSrc,
												alt: variant.image.altText,
											}
										: null,
									options: productNode.options.map(opt => ({
										name: opt.name,
										value:
											variant.selectedOptions.find(so => so.name === opt.name)
												?.value || null,
									})),
									last_synced: new Date(),
								},
							},
							raw_shopify_data: {
								product: productNode,
								variant,
								last_raw_sync: new Date(),
							},
							shopify_data: {
								product_id: shopifyProductId,
								variant_id: variant.legacyResourceId.toString(),
								title: productNode.title,
								sku: sku,
								price: parseFloat(variant.price),
								quantity: variant.inventoryQuantity || 0,
								status: productNode.status,
								last_synced: new Date(),
							},
						};

						bulkOps.push({
							updateOne: {
								filter: { sku: productData.sku },
								update: { $set: productData },
								upsert: true,
							},
						});

						if (existingSkus.has(sku)) {
							updatedProducts++; // Renamed
						} else {
							newProducts++; // Renamed
						}
					}

					processedProductCount++;
					if (
						processedProductCount % 50 === 0 ||
						processedProductCount === knownTotalCount
					) {
						// Use knownTotalCount
						updateSyncStatus(syncId, {
							currentPhase: `Processing products (${processedProductCount}/${knownTotalCount})`, // Use knownTotalCount
							progress:
								70 + Math.round((processedProductCount / knownTotalCount) * 25), // Use knownTotalCount
							processedCount: processedProductCount,
						});
					}
				} catch (error) {
					logger.error(
						`Error processing Shopify product ${productNode.legacyResourceId}`,
						{ syncId, error: error.message }
					);
				}
			}

			if (bulkOps.length > 0) {
				updateSyncStatus(syncId, {
					currentPhase: 'Writing Shopify products to database',
					progress: 95,
				});
				const dbWriteStartTime = performance.now();
				const result = await Product.bulkWrite(bulkOps, { ordered: false });
				const dbWriteEndTime = performance.now();
				logger.info(
					`[Perf] Shopify Product.bulkWrite took ${(dbWriteEndTime - dbWriteStartTime).toFixed(2)}ms`,
					{
						syncId,
						upserted: result.upsertedCount,
						modified: result.modifiedCount,
						matched: result.matchedCount,
						newProducts: newProducts,
						updatedProducts: updatedProducts, // Renamed
					}
				);
				completeSyncStatus(syncId, {
					counts: {
						added: newProducts,
						updated: updatedProducts,
						fetched: knownTotalCount,
					}, // Renamed and use knownTotalCount
					currentPhase: 'Shopify product sync complete',
				});
			} else {
				logger.info('No Shopify products to write to database.', { syncId });
				completeSyncStatus(syncId, {
					counts: { added: 0, updated: 0, fetched: knownTotalCount },
					currentPhase: 'No products to write',
				}); // Use knownTotalCount
			}
		} else {
			logger.info('No Shopify products found to process.', { syncId });
			completeSyncStatus(syncId, {
				counts: { added: 0, updated: 0, fetched: 0 },
				currentPhase: 'No products fetched',
			});
		}

		await Settings.setSetting('lastShopifyProductSync', new Date().toISOString());
		logger.info(
			`Shopify product sync completed. Synced ${newProducts} new and ${updatedProducts} updated products.`,
			{ syncId }
		); // Renamed
	} catch (error) {
		logger.error('Critical error during Shopify product sync:', {
			syncId,
			error: error.message,
			stack: error.stack,
		});
		completeSyncStatus(syncId, { currentPhase: 'Failed' }, error);
	} finally {
		const overallEndTime = performance.now();
		logger.info(
			`[Perf] Overall syncShopifyProducts took ${(overallEndTime - overallStartTime).toFixed(2)}ms`,
			{ syncId }
		);
		const currentStatus = getSyncStatus(syncId);
		if (currentStatus && !currentStatus.complete) {
			completeSyncStatus(
				syncId,
				{ currentPhase: 'Sync ended (final check)' },
				currentStatus.error ? new Error(currentStatus.error) : null
			);
		}
	}
}

/**
 * Synchronizes Shopify orders with the internal database
 * Fetches order data from Shopify, processes it, and updates the database
 * @param {string} syncId - The unique ID for this sync operation used for status tracking
 * @returns {Promise<void>}
 */
async function syncShopifyOrders(syncId) {
	const overallStartTime = performance.now();
	let newOrders = 0;
	let updatedOrders = 0;
	let knownTotalOrderCount = 0;
	let currentGraphqlLimits = null; // Variable to store limits from event

	try {
		initializeSyncStatus(syncId, 'shopify', 'orders', {
			currentPhase: 'Initializing Shopify order sync...',
			progress: 0,
		});
		const shopify = new Shopify({
			shopName: process.env.SHOPIFY_SHOP_NAME,
			accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
			apiVersion: '2023-10',
			timeout: 60000,
			autoLimit: true, // autoLimit is not effective for GraphQL, manual handling is implemented
		});

		// Event listener for GraphQL call limits
		shopify.on('callGraphqlLimits', limits => {
			logger.info('Shopify callGraphqlLimits event (Orders):', { syncId, limits });
			currentGraphqlLimits = limits; // Store the latest limits
		});

		const syncStartDate = new Date();
		syncStartDate.setDate(syncStartDate.getDate() - ORDER_SYNC_DAYS);
		const formattedSyncStartDate = syncStartDate.toISOString();

		updateSyncStatus(syncId, {
			currentPhase: `Fetching Shopify orders since ${formattedSyncStartDate.split('T')[0]} using GraphQL`,
			progress: 5,
		});

		const orderNodeFields = `
            pageInfo {
                hasNextPage
                endCursor
            }
            nodes {
                id
                name
                email
                phone
                totalPriceSet {
                    shopMoney {
                        amount
                        currencyCode
                    }
                }
                displayFinancialStatus
                displayFulfillmentStatus
                createdAt
                processedAt
                fulfillments(first: 10) {
                    id
                    status
                    createdAt
                    deliveredAt
                    trackingInfo(first: 5) {
                        company
                        number
                        url
                    }
                }
                customer {
                    id
                    firstName
                    lastName
                    email
                }
                lineItems(first: 250) {
                    nodes {
                        id
                        title
                        quantity
                        variant {
                            id
                            sku
                            product {
                                id
                            }
                        }
                        requiresShipping
                    }
                }
                shippingAddress {
                    address1
                    address2
                    city
                    zip
                    provinceCode
                    countryCode
                    phone
                    name
                    company
                }
            }
        `;

		let allShopifyOrders = [];
		let paginationInfo = null; // For GraphQL: { hasNextPage: boolean, endCursor: string | null }
		let hasNextPage = true;
		let processedOrderCountForStatus = 0; // For status updates during processing phase

		while (hasNextPage) {
			const query =
				paginationInfo?.hasNextPage && paginationInfo?.endCursor
					? ` {
                    orders(first: ${SHOPIFY_ORDER_GRAPHQL_BATCH_SIZE}, after: "${paginationInfo.endCursor}", query: "created_at:>=${formattedSyncStartDate}") {
                       ${orderNodeFields}
                    }
                }`
					: ` {
                    orders(first: ${SHOPIFY_ORDER_GRAPHQL_BATCH_SIZE}, query: "created_at:>=${formattedSyncStartDate}") {
                        ${orderNodeFields}
                    }
                }`;

			const fetchStartTime = performance.now();
			logger.info(`Fetching Shopify orders page using GraphQL`, {
				syncId,
				cursor: paginationInfo?.endCursor,
			});
			const result = await shopify.graphql(query);
			const fetchEndTime = performance.now();
			logger.info(
				`[Perf] Shopify orders GraphQL query took ${(fetchEndTime - fetchStartTime).toFixed(2)}ms`,
				{ syncId }
			);

			if (result.orders?.nodes) {
				const fetchedOrders = result.orders.nodes;
				allShopifyOrders.push(...fetchedOrders);
				paginationInfo = result.orders.pageInfo;
				hasNextPage = paginationInfo.hasNextPage;

				// Estimate total for progress display during fetching
				// This is an estimation as GraphQL doesn't provide total count for 'orders' query directly
				let currentProgressTotal;
				if (!hasNextPage) {
					knownTotalOrderCount = allShopifyOrders.length;
					currentProgressTotal = knownTotalOrderCount;
				} else {
					// Estimate: current + at least one more batch, or a running estimate if available
					currentProgressTotal =
						allShopifyOrders.length + SHOPIFY_ORDER_GRAPHQL_BATCH_SIZE;
				}

				updateSyncStatus(syncId, {
					syncCount: allShopifyOrders.length,
					totalCount: knownTotalOrderCount || currentProgressTotal,
					progress:
						5 +
						Math.min(
							65,
							Math.round((allShopifyOrders.length / (currentProgressTotal || 1)) * 65)
						),
					currentPhase: `Fetched ${allShopifyOrders.length}${knownTotalOrderCount ? ' of ' + knownTotalOrderCount : hasNextPage ? '+' : ''} Shopify orders (GraphQL)...`,
				});
			} else {
				hasNextPage = false;
				if (allShopifyOrders.length > 0 && !knownTotalOrderCount) {
					knownTotalOrderCount = allShopifyOrders.length;
				}
				updateSyncStatus(syncId, {
					syncCount: allShopifyOrders.length,
					totalCount: knownTotalOrderCount || allShopifyOrders.length,
					currentPhase: `Finished fetching Shopify orders. Total: ${allShopifyOrders.length}.`,
				});
				logger.warn(
					'Shopify orders GraphQL query returned no nodes or returned an unexpected structure.',
					{ syncId, result }
				);
			}

			// Dynamic Rate Limiting
			const limitsToUse = currentGraphqlLimits || shopify.callLimits().GRAPHQL; // Prioritize event-driven limits
			let nextDelayMs = SHOPIFY_REQUEST_DELAY_MS;

			if (limitsToUse) {
				// Check if limitsToUse is not null/undefined
				const { remaining, current, max, restoreRate } = limitsToUse;
				const actualQueryCost = current || 0;
				const queryCostForNextCall = actualQueryCost > 0 ? actualQueryCost : 50;

				logger.info(
					`GraphQL Call Limits (Orders): Cost=${actualQueryCost}, Remaining=${remaining}, Max=${max}, RestoreRate=${restoreRate}/s (Using ${currentGraphqlLimits ? 'event data' : 'callLimits()'})`,
					{ syncId }
				);
				const safetyBuffer = queryCostForNextCall * 0.5;

				if (remaining < queryCostForNextCall + safetyBuffer) {
					const pointsToRecover = queryCostForNextCall + safetyBuffer - remaining;
					if (pointsToRecover > 0 && restoreRate > 0) {
						const calculatedWaitTimeSec = pointsToRecover / restoreRate;
						nextDelayMs = Math.max(
							SHOPIFY_REQUEST_DELAY_MS,
							Math.ceil(calculatedWaitTimeSec * 1000)
						);
						logger.info(
							`Low GraphQL budget (Orders). Remaining: ${remaining}. Need to recover ~${pointsToRecover.toFixed(0)} points. Delaying for ${nextDelayMs}ms.`,
							{ syncId }
						);
					}
				} else if (remaining > queryCostForNextCall * 2 && nextDelayMs > 100) {
					// We have ample budget (more than 2 * next call cost), try to speed up slightly by reducing delay
					// but don't go below a minimum sensible delay (e.g., 100ms)
					nextDelayMs = Math.max(100, nextDelayMs / 2);
					logger.info(
						`Ample GraphQL budget (Orders). Remaining: ${remaining}. Reducing delay to ${nextDelayMs}ms.`,
						{ syncId }
					);
				}
			} else {
				logger.warn(
					'GraphQL call limits not available from event or shopify.callLimits() for orders. Using default delay.',
					{ syncId }
				);
			}

			if (hasNextPage) await shopifyHelpers.sleep(nextDelayMs);
		}

		knownTotalOrderCount = allShopifyOrders.length;
		updateSyncStatus(syncId, {
			totalCount: knownTotalOrderCount,
			syncCount: knownTotalOrderCount,
			currentPhase: 'All Shopify orders fetched (GraphQL)',
			progress: 70,
		});

		if (allShopifyOrders.length > 0) {
			const bulkOps = [];
			const existingOrderIds = new Set(
				(
					await Order.find({
						marketplace: 'shopify',
						marketplace_specific_id: {
							$in: allShopifyOrders.map(o => o.id), // Use GID (o.id)
						},
					})
						.select('marketplace_specific_id')
						.lean()
				).map(o => o.marketplace_specific_id)
			);

			for (let i = 0; i < allShopifyOrders.length; i++) {
				const orderNode = allShopifyOrders[i];
				try {
					// Ensure orderNode and id are valid before proceeding
					if (!orderNode || !orderNode.id) {
						logger.warn(
							`Skipping order due to missing id. Order Name: ${orderNode?.name}`,
							{ syncId }
						);
						continue; // Skip this iteration
					}
					const shopifyGlobalId = orderNode.id; // Use GID

					const lineItems = orderNode.lineItems.nodes.map(lineItemNode => {
						// const lineItemNode = edge.node; // No longer needed as we are iterating directly over nodes
						const variantLegacyId = lineItemNode.variant?.legacyResourceId?.toString();
						return {
							marketplace: 'shopify',
							line_item_id: lineItemNode.id.split('/').pop(), // Use the numeric part of the GraphQL ID
							variant_id: variantLegacyId,
							sku: lineItemNode.sku || lineItemNode.variant?.sku,
							title: lineItemNode.title,
							quantity: lineItemNode.quantity,
							price: parseFloat(
								lineItemNode.originalUnitPriceSet?.shopMoney?.amount || 0
							),
							is_digital: lineItemNode.nonShippable || false, // Map nonShippable
							// Add more fields from lineItemNode as needed by Order model's line_items schema
						};
					});

					// Helper to determine shipped_date from fulfillments
					let shipped_date = null;
					if (orderNode.fulfillments && orderNode.fulfillments.length > 0) {
						// Find the earliest fulfillment creation date, or a deliveredAt date
						const fulfillmentDates = orderNode.fulfillments.map(fNode =>
							new Date(fNode.createdAt).getTime()
						);
						// Potentially look for deliveredAt or specific status if available
						if (fulfillmentDates.length > 0) {
							shipped_date = new Date(Math.min(...fulfillmentDates));
						}
					}

					const orderData = {
						marketplace: 'shopify',
						marketplace_specific_id: shopifyGlobalId, // Use GID
						order_number: orderNode.name,
						order_date: new Date(orderNode.createdAt),
						updated_at_source: new Date(orderNode.updatedAt),
						customer_email: orderNode.email,
						total_price: parseFloat(orderNode.totalPriceSet?.shopMoney?.amount || 0),
						subtotal_price: parseFloat(
							orderNode.subtotalPriceSet?.shopMoney?.amount || 0
						),
						total_tax: parseFloat(orderNode.totalTaxSet?.shopMoney?.amount || 0),
						currency: orderNode.totalPriceSet?.shopMoney?.currencyCode,
						financial_status: orderNode.displayFinancialStatus,
						fulfillment_status: orderNode.displayFulfillmentStatus?.toLowerCase(),
						// status: mapFulfillmentToLocalStatus(orderNode.displayFulfillmentStatus?.toLowerCase()), // TODO: Implement mapping if needed
						tags: orderNode.tags || [],
						note: orderNode.note,
						line_items: lineItems,
						customer_details: {
							// Storing customer details
							id: orderNode.customer?.legacyResourceId?.toString(),
							firstName: orderNode.customer?.firstName,
							lastName: orderNode.customer?.lastName,
							email: orderNode.customer?.email,
						},
						shipping_address: shopifyHelpers.transformShopifyAddress(
							orderNode.shippingAddress
						), // Reuse existing helper if compatible
						billing_address: shopifyHelpers.transformShopifyAddress(
							orderNode.billingAddress
						), // Reuse existing helper if compatible
						raw_shopify_data: { order: orderNode, last_raw_sync: new Date() },
						last_synced_from_source: new Date(),
						shipped_date: shipped_date,
					};
					// Add cancelledAt if present
					if (orderNode.cancelledAt) {
						orderData.cancelled_at = new Date(orderNode.cancelledAt);
						orderData.status = 'cancelled'; // Example status mapping
					} else {
						// Basic status mapping (can be more sophisticated)
						const ffStatus = orderData.fulfillment_status;
						if (ffStatus === 'fulfilled') orderData.status = 'shipped';
						else if (
							ffStatus === 'unfulfilled' ||
							ffStatus === 'partially_fulfilled' ||
							ffStatus === 'scheduled'
						)
							orderData.status = 'unshipped';
						else orderData.status = ffStatus; // Default to the fulfillment_status
					}

					bulkOps.push({
						updateOne: {
							filter: {
								marketplace: 'shopify',
								marketplace_specific_id: shopifyGlobalId, // Use GID
							},
							update: { $set: orderData },
							upsert: true,
						},
					});

					if (existingOrderIds.has(shopifyGlobalId)) {
						// Use GID
						updatedOrders++;
					} else {
						newOrders++;
					}

					processedOrderCountForStatus++;
					if (
						processedOrderCountForStatus % 50 === 0 ||
						processedOrderCountForStatus === knownTotalOrderCount
					) {
						updateSyncStatus(syncId, {
							processedCount: processedOrderCountForStatus,
							currentPhase: `Processing Shopify orders (${processedOrderCountForStatus}/${knownTotalOrderCount})`,
							progress:
								70 +
								Math.round(
									(processedOrderCountForStatus / knownTotalOrderCount) * 25
								),
						});
					}
				} catch (error) {
					logger.error(
						`Error processing Shopify order (GraphQL) ${orderNode.name} (ID: ${orderNode.id})`,
						{ syncId, error: error.message, orderData: orderNode }
					);
				}
			}

			if (bulkOps.length > 0) {
				updateSyncStatus(syncId, {
					currentPhase: 'Writing Shopify orders to database',
					progress: 95,
				});
				const dbWriteStartTime = performance.now();
				const result = await Order.bulkWrite(bulkOps, { ordered: false });
				const dbWriteEndTime = performance.now();
				logger.info(
					`[Perf] Shopify Order.bulkWrite took ${(dbWriteEndTime - dbWriteStartTime).toFixed(2)}ms`,
					{
						syncId,
						upserted: result.upsertedCount,
						modified: result.modifiedCount,
						newOrders,
						updatedOrders,
					}
				);
				completeSyncStatus(syncId, {
					counts: {
						added: newOrders,
						updated: updatedOrders,
						fetched: knownTotalOrderCount,
					}, // Use knownTotalOrderCount
					currentPhase: 'Shopify order sync complete',
				});
			} else {
				logger.info('No Shopify orders to write to database.', { syncId });
				completeSyncStatus(syncId, {
					counts: { added: 0, updated: 0, fetched: knownTotalOrderCount },
					currentPhase: 'No orders to write',
				}); // Use knownTotalOrderCount
			}
		} else {
			logger.info('No Shopify orders found to process.', { syncId });
			completeSyncStatus(syncId, {
				counts: { added: 0, updated: 0, fetched: 0 },
				currentPhase: 'No orders fetched',
			});
		}

		await Settings.setSetting('lastShopifyOrderSync', new Date().toISOString());
		logger.info(
			`Shopify order sync completed. Synced ${newOrders} new and ${updatedOrders} updated orders.`,
			{ syncId }
		);
	} catch (error) {
		logger.error('Critical error during Shopify order sync:', {
			syncId,
			error: error.message,
			stack: error.stack,
		});
		completeSyncStatus(syncId, { currentPhase: 'Failed' }, error);
	} finally {
		const overallEndTime = performance.now();
		logger.info(
			`[Perf] Overall syncShopifyOrders took ${(overallEndTime - overallStartTime).toFixed(2)}ms`,
			{ syncId }
		);
		const currentStatus = getSyncStatus(syncId);
		if (currentStatus && !currentStatus.complete) {
			completeSyncStatus(
				syncId,
				{ currentPhase: 'Sync ended (final check)' },
				currentStatus.error ? new Error(currentStatus.error) : null
			);
		}
	}
}

module.exports = {
	syncShopifyProducts,
	syncShopifyOrders,
};
