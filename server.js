/**
 * Main server application for Etsy Inventory Management
 * Sets up Express server with middleware, templating engine, and routes
 * @module server
 */
const express = require('express');
const { engine } = require('express-handlebars');
const dotenv = require('@dotenvx/dotenvx');
const path = require('path');
dotenv.config();

// Import logger
const { logger } = require('./utils/logger');

// Log server startup
logger.info('==================== SERVER STARTING ====================');
logger.info(`Node environment: ${process.env.NODE_ENV || 'development'}`);
logger.info(`Log level: ${logger.level}`);

// Import models
const Product = require('./models/product');
const Order = require('./models/order');

// Import routes
const authRoutes = require('./routes/auth');
const orderRoutes = require('./routes/orders');
const inventoryRoutes = require('./routes/inventory');
const syncRoutes = require('./routes/sync');
const settingsRoutes = require('./routes/settings');

// Import custom middleware and helpers
const configHandlebarsHelpers = require('./utils/handlebars-helpers');
const { setupFlashMessages, refreshAuthToken } = require('./utils/middleware');
const authService = require('./utils/auth-service');
const { startOrReconfigureScheduler } = require('./utils/scheduler'); // Import the scheduler function

// Database connection
require('./config/database');

// Create express application
const app = express();

// Setup express-handlebars view engine
app.engine(
	'hbs',
	engine({
		extname: '.hbs',
		defaultLayout: 'main', // Specify the default layout file (main.hbs)
		layoutsDir: path.join(process.cwd(), 'views/layouts'), // Directory for layout files
		partialsDir: path.join(process.cwd(), 'views/partials'), // Optional: If you have other partials
		helpers: configHandlebarsHelpers(), // Pass helpers directly to the engine
	})
);
app.set('view engine', 'hbs');
app.set('views', path.join(process.cwd(), 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Add this line to parse form data

// Serve static files from assets directory
app.use('/assets', express.static(path.join(process.cwd(), 'assets')));

// Session middleware
app.use(
	require('express-session')({
		secret: process.env.SESSION_SECRET || 'your-secret-key',
		resave: false,
		saveUninitialized: false,
	})
);
app.use(require('connect-flash')());

// Make flash messages available to all views
app.use(setupFlashMessages);

// Authentication middleware
app.use(refreshAuthToken);

// Mount routers
app.use('/oauth', authRoutes);
app.use('/orders', orderRoutes);
app.use('/inventory', inventoryRoutes);
app.use('/sync', syncRoutes);
app.use('/settings', settingsRoutes);

/**
 * Main dashboard route
 * Displays key metrics and recent activity
 * @route GET /
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.get('/', async (req, res) => {
	try {
		const isAuthenticated = !authService.isTokenExpired();

		const dashboardData = isAuthenticated
			? await fetchDashboardData()
			: { needsAuthentication: true };

		res.render('dashboard', {
			...dashboardData,
			isAuthenticated,
			activePage: 'dashboard', // Keep activePage
			// No need to specify layout: 'main' if it's the default
		});
	} catch (error) {
		logger.error('Error loading dashboard:', error); // Use logger
		req.flash('error', 'Error loading dashboard');
		res.redirect('/welcome'); // Redirect somewhere safer on error
	}
});

// Login/welcome page
/**
 * Welcome/login page route
 * Entry point for unauthenticated users
 * @route GET /welcome
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.get('/welcome', (req, res) => {
	// Assuming welcome isn't a main nav item, pass null or omit activePage
	res.render('welcome', {
		first_name: req.query.first_name, // Example: pass data if needed
		// activePage: null // Or omit entirely
	});
});

// Legacy index route, redirect to dashboard
/**
 * Legacy index route (redirects to dashboard)
 * @route GET /index
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.get('/index', (req, res) => {
	res.redirect('/');
});

const { etsyRequest } = require('./utils/etsy-request-pool');

/**
 * Health check endpoint for Etsy API connection
 * Tests connection to Etsy API using the openapi-ping endpoint
 * @route GET /ping
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.get('/ping', async (req, res) => {
	try {
		const response = await etsyRequest(
			() =>
				fetch('https://api.etsy.com/v3/application/openapi-ping', {
					method: 'GET',
					headers: {
						'x-api-key': process.env.ETSY_API_KEY,
					},
				}),
			{ endpoint: '/openapi-ping', method: 'GET' }
		);
		if (response.ok) {
			const data = await response.json();
			res.send(data);
		} else {
			console.error('API Error:', response.status, response.statusText);
			const errorData = await response.json();
			console.error(errorData);
			res.status(response.status).send('API error');
		}
	} catch (error) {
		console.error('Error pinging Etsy API:', error);
		res.status(500).send('Error communicating with Etsy API');
	}
});

/**
 * Fetches all data required for the dashboard
 * @param {boolean} [useCache=true] - Whether to use cached data if available
 * @returns {Promise<Object>} Dashboard data
 */
async function fetchDashboardData(useCache = true) {
	// Add cache support
	const cache = require('./utils/cache');
	const CACHE_KEY = 'dashboard_data';
	const CACHE_TTL = 300; // 5 minutes
	
	// Try to get from cache first
	if (useCache) {
		const cachedData = cache.get(CACHE_KEY);
		if (cachedData) {
			return cachedData;
		}
	}
	
	// Cache miss or bypass, fetch fresh data
	const [
		totalProducts,
		productsWithEtsy,
		productsWithShopify,
		unshippedOrders,
		recentlyShipped,
		lowStockItems,
		recentOrdersDocs, // Rename to indicate they are Mongoose docs initially
	] = await Promise.all([
		Product.countDocuments().maxTimeMS(10000),
		Product.countDocuments({ 'etsy_data.listing_id': { $exists: true } }).maxTimeMS(10000),
		Product.countDocuments({ 'shopify_data.listing_id': { $exists: true } }).maxTimeMS(10000), // Corrected field name
		Order.countDocuments({
			status: 'unshipped', // Use the unified status field
			items: { $elemMatch: { is_digital: false } },
			// Removed Etsy-specific fields, rely on the unified status
		}).maxTimeMS(10000),
		Order.countDocuments({
			status: 'shipped', // Use the unified status field
			items: { $elemMatch: { is_digital: false } },
			shipped_date: {
				$gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
				$ne: null,
			},
		}).maxTimeMS(10000),
		Product.find({
			$expr: {
				$lt: [
					{ $subtract: ['$quantity_on_hand', '$quantity_committed'] },
					parseInt(process.env.LOW_STOCK_THRESHOLD || 5),
				],
			},
		}).maxTimeMS(10000).limit(10),
		Order.find({
			status: 'unshipped', // Use the unified status field
			items: { $elemMatch: { is_digital: false } },
			// Removed Etsy-specific fields
		})
			.maxTimeMS(10000)
			.sort({ order_date: -1 })
			.limit(5),
		// No .lean() here initially
	]);

	const stats = {
		totalProducts,
		productsWithEtsy,
		productsWithShopify,
		unshippedOrders,
		recentlyShipped,
		lowStockCount: lowStockItems.length,
	};

	// Mark critically low items (less than 2 available)
	const lowStockWithStatus = lowStockItems.map(item => {
		const availableQuantity = (item.quantity_on_hand || 0) - (item.quantity_committed || 0);
		return {
			...item.toObject(), // Convert product doc to plain object
			quantity_available: availableQuantity,
			critical: availableQuantity < 2,
		};
	});
	// Convert recentOrdersDocs to plain objects, including virtuals
	const recentOrders = recentOrdersDocs.map(order => order.toObject({ virtuals: true }));

	const dashboardData = {
		stats,
		lowStockItems: lowStockWithStatus,
		recentOrders,
	};
	
	// Cache the data for future requests
	if (useCache) {
		cache.set(CACHE_KEY, dashboardData, CACHE_TTL);
	}

	return dashboardData;
}

// Error Handling Middleware
// Keep 4-argument signature for Express, but suppress unused warning
/**
 * Global error handling middleware
 * Catches unhandled errors, logs them, and renders error page
 *
 * @param {Error} err - The error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
	logger.error('Unhandled error:', {
		message: err.message,
		stack: err.stack,
		url: req.originalUrl,
		method: req.method,
	});
	// Ensure req.flash exists before calling it, just in case
	if (req.flash) {
		req.flash('error', 'An unexpected error occurred. Please try again or contact support.');
	} else {
		// Fallback if flash isn't available for some reason
		logger.error('req.flash is not available in error handler');
		// You might store the error message in the session differently or log it
	}
	res.status(500).render('error', { error: err });
});

module.exports = app;

// Start the server if not being required as a module
if (require.main === module) {
	const port = process.env.PORT || 3003;
	app.listen(port, async () => {
		logger.info(`Server listening on port ${port}`);

		// Start the scheduler after settings are loaded and server is running
		await startOrReconfigureScheduler();
		logger.info('Scheduler initialized.');
	});
}
