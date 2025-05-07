const express = require('express');
const router = express.Router();
const Product = require('../models/product');
const { logger } = require('../utils/logger');

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
		const totalCount = await Product.countDocuments(filter);
		const totalPages = Math.ceil(totalCount / limit);

		// Get products for current page
		const products = await Product.find(filter)
			.lean()
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
			})
			.sort(sort)
			.skip(skip)
			.limit(limit);

		// Calculate available quantity for each product
		const productsWithAvailability = products.map(p => {
			p.quantity_available = (p.quantity_on_hand || 0) - (p.quantity_committed || 0);
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
		const shopifyConnected = !!product.shopify_data?.product_id;

		// Convert Mongoose document to plain object *after* calculations
		const productData = product.toObject();
		productData.quantity_available = quantity_available; // Add calculated property to the plain object

		// Log the product data being passed to the template
		logger.info('Rendering product details for SKU:', req.params.sku, {
			productData: JSON.stringify(productData, null, 2),
		}); // Log the plain object

		res.render('product-details', {
			product: productData, // Pass the plain JavaScript object
			etsyConnected,
			shopifyConnected,
			activePage: 'inventory', // Add activePage
		});
	} catch (error) {
		logger.error('Error loading product details page:', { sku: req.params.sku, error });
		req.flash('error', 'Failed to load product details');
		res.redirect('/inventory');
	}
});

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

	const totalCount = await Product.countDocuments();
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
	return Product.findOne({ sku });
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

	const product = await Product.findOne({ sku: productData.sku });

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
