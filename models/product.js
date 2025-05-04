const mongoose = require('mongoose');

// Etsy-specific marketplace data schema
const etsyDataSchema = new mongoose.Schema({
    listing_id: String,
    title: String,
    description: String,
    price: Number,
    quantity: Number,
    status: String,
    shipping_profile_id: String,
    tags: [String],
    images: [{
        url: String,
        alt: String
    }],
    last_synced: Date
});

// Shopify-specific marketplace data schema
const shopifyDataSchema = new mongoose.Schema({
    product_id: String,
    variant_id: String,
    title: String,
    description: String,
    price: Number,
    inventory_quantity: Number,
    tags: [String],
    images: [{
        url: String,
        alt: String
    }],
    handle: String,
    vendor: String,
    product_type: String,
    status: String,
    last_synced: Date
});

const productSchema = new mongoose.Schema({
    sku: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    location: { type: String },
    quantity_on_hand: { type: Number, default: 0 },
    quantity_committed: { type: Number, default: 0 },
    etsy_data: etsyDataSchema,
    shopify_data: shopifyDataSchema,
    properties: { type: Map, of: mongoose.Schema.Types.Mixed },
    raw_etsy_data: {
        listing: mongoose.Schema.Types.Mixed,
        inventory: mongoose.Schema.Types.Mixed,
        last_raw_sync: Date
    },
    raw_shopify_data: {
        product: mongoose.Schema.Types.Mixed,
        inventory: mongoose.Schema.Types.Mixed,
        last_raw_sync: Date
    },
    last_updated: { type: Date, default: Date.now }
});

// Virtual property for available quantity
productSchema.virtual('quantity_available').get(function() {
    return this.quantity_on_hand - this.quantity_committed;
});

const Product = mongoose.model('Product', productSchema);
module.exports = Product;