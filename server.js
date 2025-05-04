const express = require('express');
const hbs = require("hbs");
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

// We don't need to initialize Shopify client directly here 
// as we're using the shopify-helpers.js utility throughout the app

// Create express application
const app = express();

// Setup handlebars view engine with layouts support
app.set("view engine", "hbs");
app.set("views", path.join(process.cwd(), "views"));
hbs.registerPartials(path.join(process.cwd(), "views/layouts"));

// Configure handlebars helpers
configHandlebarsHelpers(hbs);

// Middleware
app.use(express.json());
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
        
        // If not authenticated, still show the dashboard but with auth status
        const dashboardData = isAuthenticated ? 
            await fetchDashboardData() : 
            { needsAuthentication: true };
            
        res.render('dashboard', {
            ...dashboardData,
            isAuthenticated
        });
    } catch (error) {
        console.error('Error loading dashboard:', error);
        res.status(500).send('Error loading dashboard');
    }
});

// Login/welcome page
app.get('/welcome', (req, res) => {
    res.render("welcome");
});

// Legacy index route, redirect to dashboard
app.get('/index', (req, res) => {
    res.redirect('/');
});

app.get('/ping', async (req, res) => {
    try {
        const response = await fetch(
            'https://api.etsy.com/v3/application/openapi-ping',
            {
                method: 'GET',
                headers: {
                    'x-api-key': process.env.ETSY_API_KEY,
                }
            }
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
        recentOrders
    ] = await Promise.all([
        Product.countDocuments(),
        Product.countDocuments({ 'etsy_data.listing_id': { $exists: true } }),
        Product.countDocuments({ 'shopify_data.listing_id': { $exists: true } }),
        Order.countDocuments({ 
            etsy_is_shipped: false,
            items: { $elemMatch: { is_digital: false } },
            'etsy_order_data.status': { $ne: 'Canceled' }
        }),
        Order.countDocuments({
            etsy_is_shipped: true,
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
            etsy_is_shipped: false,
            'etsy_order_data.status': { $ne: 'Canceled' }
        })
        .sort({ order_date: -1 })
        .limit(5)
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
            ...item.toObject(),
            quantity_available: availableQuantity,
            critical: availableQuantity < 2
        };
    });

    return {
        stats,
        lowStockItems: lowStockWithStatus,
        recentOrders
    };
}

module.exports = app;

// Start the server if not being required as a module
if (require.main === module) {
    const port = process.env.PORT || 3003;
    app.listen(port, () => {
        logger.info(`Server listening on port ${port}`);
        logger.info('==================== SERVER READY =====================');
    });
}