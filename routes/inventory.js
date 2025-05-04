const express = require('express');
const router = express.Router();
const Product = require('../models/product');
const { logger } = require('../utils/logger');

/**
 * Get the main inventory grid view
 */
router.get('/', async (req, res) => {
    try {
        const { totalCount, columns } = await getInventoryViewData();
        res.render('inventory', { 
            initialCount: totalCount, 
            columns: columns
        });
    } catch (error) {
        logger.error('Error fetching inventory view:', error);
        req.flash('error', 'Error loading inventory');
        res.status(500).send('Error loading inventory');
    }
});

/**
 * Get the inventory gallery view
 */
router.get('/gallery', async (req, res) => {
    try {
        const { totalCount, columns } = await getInventoryViewData();
        res.render('inventory-gallery', { 
            initialCount: totalCount, 
            columns: columns,
            title: 'Inventory Gallery View'
        });
    } catch (error) {
        logger.error('Error fetching inventory gallery view:', error);
        req.flash('error', 'Error loading inventory gallery view');
        res.status(500).send('Error loading inventory gallery view');
    }
});

/**
 * API endpoint for paginated inventory data
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
                'sku': 1, 
                'name': 1, 
                'location': 1, 
                'quantity_on_hand': 1,
                'quantity_committed': 1,
                'properties': 1,
                'etsy_data.listing_id': 1,
                'etsy_data.quantity': 1,
                'etsy_data.last_synced': 1,
                'etsy_data.images': 1,
                'shopify_data.product_id': 1,
                'shopify_data.variant_id': 1,
                'shopify_data.inventory_quantity': 1,
                'shopify_data.last_synced': 1
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
                pageSize: limit
            }
        });
    } catch (error) {
        logger.error('Error fetching paginated inventory data:', error);
        res.status(500).json({ error: 'Failed to fetch inventory data' });
    }
});

/**
 * API endpoint to get product details by SKU
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
 */
router.get('/details/:sku', async (req, res) => {
    try {
        const product = await findProductBySku(req.params.sku);
        
        if (!product) {
            req.flash('error', 'Product not found');
            return res.redirect('/inventory');
        }
        
        // Calculate available quantity
        product.quantity_available = calculateAvailableQuantity(product);
        
        // Check if product is connected to marketplaces
        const etsyConnected = !!product.etsy_data?.listing_id;
        const shopifyConnected = !!product.shopify_data?.product_id;
        
        res.render('product-details', { 
            product,
            etsyConnected,
            shopifyConnected
        });
    } catch (error) {
        logger.error('Error loading product details page:', { sku: req.params.sku, error });
        req.flash('error', 'Failed to load product details');
        res.redirect('/inventory');
    }
});

/**
 * API endpoint to update one or more products
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
                errors
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
 */
router.post('/properties', async (req, res) => {
    const { propertyName } = req.body;
    
    if (!propertyName || typeof propertyName !== 'string') {
        return res.status(400).json({ error: 'Valid property name required' });
    }
    
    try {
        await Product.updateMany(
            {},
            { [`properties.${propertyName}`]: '' }
        );
        
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
 * @returns {Promise<Object>} View data including column definitions
 */
async function getInventoryViewData() {
    // Get total count for pagination info
    const totalCount = await Product.countDocuments();
    
    // Get unique property names for columns
    const propertyNames = await getUniquePropertyNames();
    
    // Create columns configuration
    const columns = [
        { data: 'sku', title: 'SKU', readOnly: true },
        { data: 'name', title: 'Name' },
        { data: 'location', title: 'Location' },
        { data: 'quantity_on_hand', title: 'On Hand' },
        { data: 'quantity_committed', title: 'Committed', readOnly: true },
        { data: 'quantity_available', title: 'Available', readOnly: true },
        { data: 'etsy_data.quantity', title: 'Etsy Qty', readOnly: true },
        { data: 'shopify_data.inventory_quantity', title: 'Shopify Qty', readOnly: true },
        ...Array.from(propertyNames).map(prop => ({
            data: `properties.${prop}`,
            title: prop
        }))
    ];
    
    return { totalCount, columns };
}

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
            { location: { $regex: search, $options: 'i' } }
        ]
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

/**
 * Get all unique property names from products collection
 * @returns {Promise<Set<String>>} Set of unique property names
 */
async function getUniquePropertyNames() {
    const allProperties = new Set();
    
    // Find products with properties
    const productsWithProps = await Product.find({ properties: { $exists: true } })
        .lean()
        .select('properties');
    
    // Collect all unique property names
    productsWithProps.forEach(product => {
        if (product.properties) {
            Object.keys(product.properties).forEach(key => {
                allProperties.add(key);
            });
        }
    });
    
    return allProperties;
}

module.exports = router;