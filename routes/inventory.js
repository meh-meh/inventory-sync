const express = require('express');
const router = express.Router();
const Product = require('../models/product');
const etsyHelpers = require('../utils/etsy-helpers');
const { logger } = require('../utils/logger');
const { getProductThumbnail, buildShopifyUrl } = require('../utils/product-helpers');

/**
 * Get the main inventory gallery view
 * @route GET /inventory
 * @returns {Object} Renders the inventory-gallery view with product data
 */
router.get('/', async (req, res) => {
	// Reverted: Render gallery view by default
	try {
		const { totalCount, columns } = await getInventoryViewData();
		res.render('inventory-gallery', {
			initialCount: totalCount,
			columns: columns,
			title: 'Inventory Gallery View',
			activePage: 'inventory', // Add activePage
		});
	} catch (error) {
		logger.error('Error fetching inventory gallery view:', error);
		req.flash('error', 'Error loading inventory gallery view');
		res.status(500).send('Error loading inventory gallery view');
	}
});

/**
 * Get the inventory table view
 * @route GET /inventory/table
 * @returns {Object} Renders the inventory table view with product data
 */
router.get('/table', async (req, res) => {
	// Reinstated route for table view
	try {
		const { totalCount, columns } = await getInventoryViewData();
		res.render('inventory', {
			initialCount: totalCount,
			columns: columns,
			title: 'Inventory Table View',
			activePage: 'inventory', // Add activePage
		});
	} catch (error) {
		logger.error('Error fetching inventory table view:', error);
		req.flash('error', 'Error loading inventory table view');
		res.status(500).send('Error loading inventory table view');
	}
});

/**
 * Get the inventory gallery view (kept for potential direct linking, redirects to /)
 * @route GET /inventory/gallery
 * @returns {Object} Redirects to the main inventory route
 */
router.get('/gallery', (req, res) => {
	res.redirect('/inventory'); // Redirect old gallery link to the new default
});

/**
 * API endpoint for paginated inventory data
 * @route GET /inventory/api/data
 * @param {Number} req.query.page - Page number for pagination (default: 1)
 * @param {Number} req.query.limit - Number of items per page (default: 10)
 * @param {String} req.query.sort - Field to sort by (default: 'sku')
 * @param {String} req.query.order - Sort order ('asc' or 'desc')
 * @param {String} req.query.search - Search string to filter products
 * @returns {Object} JSON with products data and pagination info
 */
router.get('/api/data', async (req, res) => {
	try {
		// Get pagination parameters
		const page = parseInt(req.query.page) || 1;
		const limit = parseInt(req.query.limit) || 10;
		const sortField = req.query.sort || 'sku';
		const sortOrder = req.query.order === 'desc' ? -1 : 1;
		const search = req.query.search || '';

		// Calculate skip value for pagination
		const skip = (page - 1) * limit;

		// Build search filter
		let filter = buildSearchFilter(search);

		// Build sort object
		const sort = {};
		sort[sortField] = sortOrder;
		// Get total count with filter applied
		const totalCount = await Product.countDocuments(filter).maxTimeMS(10000);
		const totalPages = Math.ceil(totalCount / limit);
		// Get products for current page
		const products = await Product.find(filter)
			.lean()
			.maxTimeMS(15000) // 15-second timeout for pagination queries
			.select({
				sku: 1,
				name: 1,
				location: 1,
				quantity_on_hand: 1,
				quantity_committed: 1,
				properties: 1,
				'etsy_data.listing_id': 1,
				'etsy_data.quantity': 1,
				'etsy_data.last_synced': 1,
				'etsy_data.images': 1,
				'shopify_data.product_id': 1,
				'shopify_data.variant_id': 1,
				'shopify_data.inventory_quantity': 1,
				'shopify_data.last_synced': 1,
				// include raw shopify product images (GraphQL edges) and online_store_url as fallback
				'raw_shopify_data.product.images': 1,
				'raw_shopify_data.product.online_store_url': 1,
			})
			.sort(sort)
			.skip(skip)
			.limit(limit);

		// Helper to pick a thumbnail: prefer Etsy image, then Shopify raw originalSrc, then online_store_url
		// Calculate available quantity and derive thumbnail/shopify_url for each product using helpers
		const productsWithAvailability = products.map(p => {
			p.quantity_available = (p.quantity_on_hand || 0) - (p.quantity_committed || 0);
			p.thumbnail_url = getProductThumbnail(p);
			// Provide a shopify admin/storefront URL when possible (pass env/settings resolution at product-details)
			p.shopify_url = buildShopifyUrl(p, process.env.SHOPIFY_SHOP_NAME || null);
			return p;
		});

		res.json({
			products: productsWithAvailability,
			pagination: {
				totalItems: totalCount,
				totalPages: totalPages,
				currentPage: page,
				pageSize: limit,
			},
		});
	} catch (error) {
		logger.error('Error fetching paginated inventory data:', error);
		res.status(500).json({ error: 'Failed to fetch inventory data' });
	}
});

/**
 * API endpoint to get product details by SKU
 * @route GET /inventory/product/:sku
 * @param {String} req.params.sku - Product SKU to retrieve
 * @returns {Object} JSON with product details or error message
 */
router.get('/product/:sku', async (req, res) => {
	try {
		const product = await findProductBySku(req.params.sku);

		if (!product) {
			return res.status(404).json({ error: 'Product not found' });
		}

		// Convert to object with availability
		const productData = product.toObject();
		productData.quantity_available = calculateAvailableQuantity(product);
		// Provide shop domain fallback to the client so storefront/admin links can be built
		let shopifyShopName = process.env.SHOPIFY_SHOP_NAME || process.env.SHOPIFY_SHOP || null;
		if (!shopifyShopName) {
			try {
				const Settings = require('../models/settings');
				const saved = await Settings.getSetting('shopifyShopName');
				if (saved) shopifyShopName = saved;
			} catch {
				// Ignore and continue without persistent fallback
			}
		}

		// Attach only if we have a non-empty string to avoid passing falsy values
		if (shopifyShopName) productData.shopifyShopName = shopifyShopName;

		// Add shopify_url using helper
		try {
			productData.shopify_url = buildShopifyUrl(productData, shopifyShopName) || null;
		} catch {
			// ignore
		}

		// Provide a helper boolean to indicate if Shopify linkage looks valid
		const sd = product.shopify_data || {};
		const raw =
			product.raw_shopify_data && product.raw_shopify_data.product
				? product.raw_shopify_data.product
				: null;
		const shopifyConnected = !!(
			sd.product_url ||
			sd.product_id ||
			sd.handle ||
			(raw && (raw.online_store_url || raw.handle || raw.id))
		);
		productData.shopifyConnected = shopifyConnected;

		res.json(productData);
	} catch (error) {
		logger.error('Error fetching product details:', { sku: req.params.sku, error });
		res.status(500).json({ error: 'Failed to fetch product details' });
	}
});

/**
 * Route to display product details page
 * @route GET /inventory/details/:sku
 * @param {String} req.params.sku - Product SKU to display details for
 * @returns {Object} Renders the product-details view or redirects on error
 */
router.get('/details/:sku', async (req, res) => {
	try {
		const product = await findProductBySku(req.params.sku);

		if (!product) {
			req.flash('error', 'Product not found');
			return res.redirect('/inventory');
		}

		// Calculate available quantity
		const quantity_available = calculateAvailableQuantity(product); // Calculate first

		// Check if product is connected to marketplaces
		const etsyConnected = !!product.etsy_data?.listing_id;
		// Treat Shopify as connected if any identifying Shopify data exists
		const shopifyConnected = !!(
			(product.shopify_data &&
				(product.shopify_data.product_id ||
					product.shopify_data.handle ||
					product.shopify_data.product_url ||
					product.shopify_data.shop_domain)) ||
			// Also consider raw shopify product data as evidence of a connection
			(product.raw_shopify_data && product.raw_shopify_data.product)
		);

		// Convert Mongoose document to plain object *after* calculations
		const productData = product.toObject();
		productData.quantity_available = quantity_available; // Add calculated property to the plain object

		// Log the product data being passed to the template
		logger.info('Rendering product details for SKU:', req.params.sku, {
			productData: JSON.stringify(productData, null, 2),
		}); // Log the plain object

		// Determine shopifyShopName to pass to templates (env -> settings)
		let shopifyShopName = process.env.SHOPIFY_SHOP_NAME || process.env.SHOPIFY_SHOP || null;
		if (!shopifyShopName) {
			try {
				const Settings = require('../models/settings');
				const saved = await Settings.getSetting('shopifyShopName');
				if (saved) shopifyShopName = saved;
			} catch {
				// ignore
			}
		}

		res.render('product-details', {
			product: productData, // Pass the plain JavaScript object
			etsyConnected,
			shopifyConnected,
			shopifyShopName,
			activePage: 'inventory', // Add activePage
		});
	} catch (error) {
		logger.error('Error loading product details page:', { sku: req.params.sku, error });
		req.flash('error', 'Failed to load product details');
		res.redirect('/inventory');
	}
});

/**
 * Search for candidate Etsy listings to link to a Shopify product
 * Returns up to ~5 Etsy products with sku starting with 'ETSY-' matching by title and images
 * @route GET /inventory/:sku/etsy-candidates
 */
router.get('/:sku/etsy-candidates', async (req, res) => {
	try {
		const sku = req.params.sku;
		const product = await findProductBySku(sku);
		if (!product) return res.status(404).json({ error: 'Product not found' });

		// Only run for Shopify-backed SKUs (not ETSY- defaults)
		if (sku.startsWith('ETSY-'))
			return res.status(400).json({ error: 'This SKU appears to be an Etsy product' });

		// Construct a simple text-based match on title; case-insensitive
		const title = product.name || product.shopify_data?.title || '';
		// split title into tokens

		// Build token list to use in matching
		const tokens = title
			.split(/[\s\-_/]+/)
			.map(t => t.trim())
			.filter(Boolean)
			.slice(0, 6);

		// Build regex to match similar titles using lookahead (AND-match) when possible
		let candidates = [];
		if (tokens.length > 0) {
			const lookaheadPattern = tokens.map(t => `(?=.*${escapeRegExp(t)})`).join('');
			const regex = new RegExp(lookaheadPattern, 'i');

			// Search for ETSY- records that aren't yet linked to Shopify (sku starts with ETSY-)
			candidates = await Product.find({
				sku: { $regex: '^ETSY-' },
				$or: [{ 'etsy_data.title': { $regex: regex } }, { name: { $regex: regex } }],
			})
				.select({ sku: 1, name: 1, etsy_data: 1 })
				.limit(8)
				.lean()
				.maxTimeMS(10000);
		}

		// If no candidates from the strict AND-match, run a looser OR-based token search (any token)
		if ((!candidates || candidates.length === 0) && tokens.length > 0) {
			const orConditions = [];
			tokens.forEach(t => {
				const r = new RegExp(escapeRegExp(t), 'i');
				orConditions.push({ 'etsy_data.title': { $regex: r } });
				orConditions.push({ name: { $regex: r } });
			});

			const fallback = await Product.find({ sku: { $regex: '^ETSY-' }, $or: orConditions })
				.select({ sku: 1, name: 1, etsy_data: 1 })
				.limit(12)
				.lean()
				.maxTimeMS(10000);

			candidates = fallback || [];
		}

		// Heuristic scoring: title similarity and image presence
		const scored = candidates
			.map(c => {
				let score = 0;
				if (
					c.etsy_data &&
					c.etsy_data.title &&
					title &&
					c.etsy_data.title.toLowerCase().includes(title.toLowerCase())
				)
					score += 5;
				if (
					c.etsy_data &&
					Array.isArray(c.etsy_data.images) &&
					c.etsy_data.images.length > 0
				)
					score += 3;
				// small boost if the stored 'name' matches
				if (c.name && title && c.name.toLowerCase().includes(title.toLowerCase()))
					score += 2;
				return { candidate: c, score };
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, 5)
			.map(s => s.candidate);

		res.json({ candidates: scored });
	} catch (err) {
		logger.error('Error searching Etsy candidates', { error: err.message });
		res.status(500).json({ error: 'Failed to search candidates' });
	}
});

/**
 * Link a Shopify product (sku) to an Etsy listing (by Etsy listing id or ETSY- sku)
 * This will copy etsy_data into the shopify SKU product, delete the ETSY- record, and write the sku to Etsy listing
 * @route POST /inventory/:sku/link-etsy
 * @body { listingId?: string, etsySku?: string }
 */
router.post('/:sku/link-etsy', async (req, res) => {
	try {
		const sku = req.params.sku;
		const { listingId, etsySku } = req.body || {};
		const target = await findProductBySku(sku);
		if (!target) return res.status(404).json({ error: 'Target product not found' });
		if (sku.startsWith('ETSY-'))
			return res.status(400).json({ error: 'Target must be a Shopify SKU' });

		// Resolve the ets y product either by explicit listingId or by etsySku
		let etsyProduct = null;
		if (etsySku) {
			etsyProduct = await findProductBySku(etsySku);
			if (!etsyProduct)
				return res.status(404).json({ error: 'Etsy product not found by SKU' });
		} else if (listingId) {
			// try to find matching ETSY- record by listing id
			etsyProduct = await Product.findOne({
				'etsy_data.listing_id': listingId,
				sku: { $regex: '^ETSY-' },
			}).maxTimeMS(10000);
			if (!etsyProduct) {
				// If not in DB, fetch from Etsy and synthesize minimal data
				try {
					const listing = await etsyHelpers.getListing(listingId);
					if (listing) {
						etsyProduct = {
							sku: `ETSY-${listingId}`,
							name: listing.title || listing.title || `Etsy ${listingId}`,
							etsy_data: {
								listing_id: listingId,
								title: listing.title,
								description: listing.description,
								price:
									listing.price && listing.price.amount
										? parseFloat(listing.price.amount)
										: null,
								quantity: listing.quantity,
								status: listing.state,
								images: (listing.images || []).map(i => ({
									url: i.url_fullxfull || i.url_570xN || i.url,
								})),
							},
						};
					}
				} catch (e) {
					logger.warn('Could not fetch listing from Etsy during link', {
						listingId,
						error: e.message,
					});
				}
			}
		} else {
			return res.status(400).json({ error: 'listingId or etsySku required' });
		}

		if (!etsyProduct) return res.status(404).json({ error: 'Etsy product not found' });

		// If etsyProduct is a mongoose doc, convert to plain object
		const etsyObj = etsyProduct.toObject ? etsyProduct.toObject() : etsyProduct;

		// Merge Etsy-specific fields into target.shopify_data (copy etsy_data into target.shopify_data fields prefixed as needed)
		// We'll copy title/description/images and set etsy_data on the target
		target.etsy_data = etsyObj.etsy_data || {
			listing_id: listingId || (etsyObj.sku && etsyObj.sku.replace(/^ETSY-/, '')),
			title: etsyObj.etsy_data?.title || etsyObj.title || etsyObj.name,
			description: etsyObj.etsy_data?.description || etsyObj.description,
			price: etsyObj.etsy_data?.price || etsyObj.price,
			quantity: etsyObj.etsy_data?.quantity || etsyObj.quantity,
			status: etsyObj.etsy_data?.status || etsyObj.status,
			tags: etsyObj.etsy_data?.tags || etsyObj.tags || [],
			images: etsyObj.etsy_data?.images || etsyObj.images || [],
			last_synced: new Date(),
		};

		// Write SKU to Etsy listing (attempt), but do not block DB changes if Etsy update fails; report result
		const newSku = sku;
		let etsyUpdateResult = null;
		try {
			const listing_id_to_update =
				target.etsy_data.listing_id ||
				(etsyObj.etsy_data && etsyObj.etsy_data.listing_id) ||
				(etsyObj.sku && etsyObj.sku.replace(/^ETSY-/, ''));
			if (listing_id_to_update) {
				etsyUpdateResult = await etsyHelpers.updateListingSku(listing_id_to_update, newSku);
			}
		} catch (e) {
			// Capture the error details to return to the client for debugging
			logger.warn('Failed to write SKU to Etsy listing', { error: e.message });
			etsyUpdateResult = { error: e.message };
		}

		// Save updated target product
		await target.save();

		// Delete the ETSY- record if it exists as a separate document
		if (etsyProduct && etsyProduct._id) {
			await Product.deleteOne({ _id: etsyProduct._id }).maxTimeMS(10000);
		}

		res.json({ success: true, etsyUpdateResult });
	} catch (err) {
		logger.error('Error linking Etsy product', { error: err.message });
		res.status(500).json({ error: 'Failed to link Etsy product' });
	}
});

// small helper
function escapeRegExp(string) {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * API endpoint to update one or more products
 * @route POST /inventory
 * @param {Object} req.body.changes - Array of product data objects to update or create
 * @returns {Object} JSON with success status or error messages
 */
router.post('/', async (req, res) => {
	try {
		const { changes } = req.body;

		if (!Array.isArray(changes)) {
			return res.status(400).json({ error: 'Changes must be an array' });
		}

		const results = await Promise.all(
			changes.map(async row => {
				try {
					return await updateOrCreateProduct(row);
				} catch (err) {
					logger.error('Error updating product:', { sku: row.sku, error: err });
					return { sku: row.sku, error: err.message };
				}
			})
		);

		const errors = results.filter(r => r.error);
		if (errors.length) {
			return res.status(207).json({
				message: 'Some products could not be updated',
				errors,
			});
		}

		res.json({ success: true });
	} catch (error) {
		logger.error('Error saving inventory:', error);
		res.status(500).json({ error: 'Error saving inventory' });
	}
});

/**
 * API endpoint to add a new property to all products
 * @route POST /inventory/properties
 * @param {String} req.body.propertyName - Name of the property to add to all products
 * @returns {Object} JSON with success status or error message
 */
router.post('/properties', async (req, res) => {
	const { propertyName } = req.body;

	if (!propertyName || typeof propertyName !== 'string') {
		return res.status(400).json({ error: 'Valid property name required' });
	}

	try {
		await Product.updateMany({}, { [`properties.${propertyName}`]: '' });

		logger.info('Added new property to all products', { propertyName });
		res.json({ success: true });
	} catch (error) {
		logger.error('Error adding property:', { propertyName, error });
		res.status(500).json({ error: 'Error adding property' });
	}
});

// -----------------
// Helper Functions
// -----------------

/**
 * Get data required for inventory views (grid and table)
 * @returns {Promise<Object>} Object containing totalCount and columns configuration
 */
async function getInventoryViewData() {
	// Placeholder: Define columns statically or fetch if needed
	let columns = [
		{ data: 'sku', title: 'SKU', type: 'text', readOnly: true },
		{ data: 'name', title: 'Name', type: 'text' },
		{ data: 'location', title: 'Location', type: 'text' },
		{ data: 'quantity_on_hand', title: 'On Hand', type: 'numeric' },
		{ data: 'quantity_committed', title: 'Committed', type: 'numeric', readOnly: true },
		{ data: 'quantity_available', title: 'Available', type: 'numeric', readOnly: true },
		{ data: 'etsy_data.quantity', title: 'Etsy Qty', type: 'numeric', readOnly: true },
		{
			data: 'shopify_data.inventory_quantity',
			title: 'Shopify Qty',
			type: 'numeric',
			readOnly: true,
		},
		// Add other columns as needed
	];

	// Example: Fetch distinct properties if you want dynamic columns
	// const distinctProperties = await getUniquePropertyNames();
	// distinctProperties.forEach(propName => {
	//     columns.push({ data: `properties.${propName}`, title: propName, type: 'text' });
	// });
	const totalCount = await Product.countDocuments().maxTimeMS(10000);
	return { totalCount, columns };
}

// Example function if you need dynamic properties
/**
 * Get a list of all unique property names used across products
 * @returns {Promise<Array<String>>} Array of unique property names
 */
// async function getUniquePropertyNames() {
//     const products = await Product.find({ 'properties.0': { $exists: true } }).select('properties.name').lean();
//     const propertyNames = new Set();
//     products.forEach(p => {
//         if (p.properties) {
//             p.properties.forEach(prop => propertyNames.add(prop.name));
//         }
//     });
//     return Array.from(propertyNames);
// }

/**
 * Build search filter for inventory queries
 * @param {String} search - Search query
 * @returns {Object} MongoDB filter object
 */
function buildSearchFilter(search) {
	if (!search) return {};

	return {
		$or: [
			{ sku: { $regex: search, $options: 'i' } },
			{ name: { $regex: search, $options: 'i' } },
			{ location: { $regex: search, $options: 'i' } },
		],
	};
}

/**
 * Find a product by its SKU
 * @param {String} sku - Product SKU
 * @returns {Promise<Object|null>} Product document or null if not found
 */
async function findProductBySku(sku) {
	return Product.findOne({ sku }).maxTimeMS(10000);
}

/**
 * Calculate available quantity for a product
 * @param {Object} product - Product document
 * @returns {Number} Available quantity
 */
function calculateAvailableQuantity(product) {
	return (product.quantity_on_hand || 0) - (product.quantity_committed || 0);
}

/**
 * Update an existing product or create a new one
 * @param {Object} productData - Product data
 * @returns {Promise<Object>} Updated or created product
 */
async function updateOrCreateProduct(productData) {
	if (!productData.sku) {
		throw new Error('SKU is required');
	}

	const product = await Product.findOne({ sku: productData.sku }).maxTimeMS(10000);

	if (product) {
		Object.assign(product, productData);
		await product.save();
		logger.info('Updated product', { sku: productData.sku });
		return product;
	} else {
		const newProduct = await Product.create(productData);
		logger.info('Created new product', { sku: productData.sku });
		return newProduct;
	}
}

module.exports = router;
