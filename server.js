const express = require('express');
const { engine } = require('express-handlebars');
const dotenv = require("@dotenvx/dotenvx");
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

// Database connection
require('./config/database');

// Create express application
const app = express();

// Setup express-handlebars view engine
app.engine('hbs', engine({ 
    extname: '.hbs', 
    defaultLayout: 'main', // Specify the default layout file (main.hbs)
    layoutsDir: path.join(process.cwd(), 'views/layouts'), // Directory for layout files
    partialsDir: path.join(process.cwd(), 'views/partials'), // Optional: If you have other partials
    helpers: configHandlebarsHelpers() // Pass helpers directly to the engine
}));
app.set('view engine', 'hbs');
app.set('views', path.join(process.cwd(), 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Add this line to parse form data

// Session middleware
app.use(require('express-session')({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false
}));
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

// Dashboard route
app.get('/', async (req, res) => {
    try {
        const isAuthenticated = !authService.isTokenExpired();
        
        const dashboardData = isAuthenticated ? 
            await fetchDashboardData() : 
            { needsAuthentication: true };
            
        res.render('dashboard', {
            ...dashboardData,
            isAuthenticated,
            activePage: 'dashboard' // Keep activePage
            // No need to specify layout: 'main' if it's the default
        });
    } catch (error) {
        logger.error('Error loading dashboard:', error); // Use logger
        req.flash('error', 'Error loading dashboard');
        res.redirect('/welcome'); // Redirect somewhere safer on error
    }
});

// Login/welcome page
app.get('/welcome', (req, res) => {
    // Assuming welcome isn't a main nav item, pass null or omit activePage
    res.render("welcome", { 
        first_name: req.query.first_name // Example: pass data if needed
        // activePage: null // Or omit entirely
    }); 
});

// Legacy index route, redirect to dashboard
app.get('/index', (req, res) => {
    res.redirect('/');
});

const { etsyRequest } = require('./utils/etsy-request-pool');

app.get('/ping', async (req, res) => {
    try {
        const response = await etsyRequest(
            () => fetch(
                'https://api.etsy.com/v3/application/openapi-ping',
                {
                    method: 'GET',
                    headers: {
                        'x-api-key': process.env.ETSY_API_KEY,
                    }
                }
            ),
            { endpoint: '/openapi-ping', method: 'GET' }
        );
        if (response.ok) {
            const data = await response.json();
            res.send(data);
        } else {
            console.error('API Error:', response.status, response.statusText);
            const errorData = await response.json();
            console.error(errorData);
            res.status(response.status).send("API error");
        }
    } catch (error) {
        console.error('Error pinging Etsy API:', error);
        res.status(500).send('Error communicating with Etsy API');
    }
});

/**
 * Fetches all data required for the dashboard
 * @returns {Promise<Object>} Dashboard data
 */
async function fetchDashboardData() {
    const [
        totalProducts,
        productsWithEtsy,
        productsWithShopify,
        unshippedOrders,
        recentlyShipped,
        lowStockItems,
        recentOrdersDocs // Rename to indicate they are Mongoose docs initially
    ] = await Promise.all([
        Product.countDocuments(),
        Product.countDocuments({ 'etsy_data.listing_id': { $exists: true } }),
        Product.countDocuments({ 'shopify_data.listing_id': { $exists: true } }), // Corrected field name
        Order.countDocuments({ 
            status: 'unshipped', // Use the unified status field
            items: { $elemMatch: { is_digital: false } }
            // Removed Etsy-specific fields, rely on the unified status
        }),
        Order.countDocuments({
            status: 'shipped', // Use the unified status field
            items: { $elemMatch: { is_digital: false } },
            shipped_date: { 
                $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                $ne: null
            }
        }),
        Product.find({
            $expr: {
                $lt: [
                    { $subtract: ['$quantity_on_hand', '$quantity_committed'] },
                    parseInt(process.env.LOW_STOCK_THRESHOLD || 5)
                ]
            }
        }).limit(10),
        Order.find({ 
            status: 'unshipped', // Use the unified status field
            items: { $elemMatch: { is_digital: false } }
            // Removed Etsy-specific fields
        })
        .sort({ order_date: -1 })
        .limit(5)
        // No .lean() here initially
    ]);

    const stats = {
        totalProducts,
        productsWithEtsy,
        productsWithShopify,
        unshippedOrders,
        recentlyShipped,
        lowStockCount: lowStockItems.length
    };

    // Mark critically low items (less than 2 available)
    const lowStockWithStatus = lowStockItems.map(item => {
        const availableQuantity = (item.quantity_on_hand || 0) - (item.quantity_committed || 0);
        return {
            ...item.toObject(), // Convert product doc to plain object
            quantity_available: availableQuantity,
            critical: availableQuantity < 2
        };
    });

    // Convert recentOrdersDocs to plain objects, including virtuals
    const recentOrders = recentOrdersDocs.map(order => order.toObject({ virtuals: true }));

    return {
        stats,
        lowStockItems: lowStockWithStatus,
        recentOrders // Pass the array of plain objects
    };
}

// Error Handling Middleware
// Add 'next' to the signature for Express to recognize it as an error handler
app.use((err, req, res) => { 
    logger.error('Unhandled error:', { 
        message: err.message, 
        stack: err.stack, 
        url: req.originalUrl, 
        method: req.method 
    });
    // Ensure req.flash exists before calling it, just in case
    if (req.flash) {
        req.flash('error', 'An unexpected error occurred. Please try again or contact support.');
    } else {
        // Fallback if flash isn't available for some reason
        logger.error('req.flash is not available in error handler');
        // You might store the error message in the session differently or log it
    }
    const status = err.status || 500;
    res.status(status);
    
    res.render('error', { 
        message: err.message,
        // Only provide detailed error in development
        error: process.env.NODE_ENV === 'development' ? err : {},
        layout: 'main' // Explicitly use main layout, or set to false if no layout desired for errors
    }); 
    // Note: We don't call next() here because we are sending the response.
});

module.exports = app;

// Start the server if not being required as a module
if (require.main === module) {
    const port = process.env.PORT || 3003;
    app.listen(port, () => {
        logger.info(`Server listening on port ${port}`);
        logger.info('==================== SERVER READY =====================');
    });
}