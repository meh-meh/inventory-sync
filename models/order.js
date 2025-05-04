const mongoose = require('mongoose');

// Generic order item schema with marketplace-specific fields
const orderItemSchema = new mongoose.Schema({
    marketplace: { type: String, enum: ['etsy', 'shopify'], required: true },
    // Common fields
    sku: { type: String, required: true },
    quantity: { type: Number, required: true },
    is_digital: { type: Boolean, default: false },
    // Etsy-specific fields
    receipt_id: String,
    listing_id: String,
    transaction_id: String,
    // Shopify-specific fields
    line_item_id: String,
    variant_id: String,
    product_id: String
});

const orderSchema = new mongoose.Schema({
    // Common fields across marketplaces
    order_id: { type: String, required: true, unique: true },
    marketplace: { type: String, enum: ['etsy', 'shopify'], required: true },
    order_date: { type: Date, required: true },
    buyer_name: String,
    status: {
        type: String,
        enum: ['unshipped', 'shipped'],
        default: 'unshipped'
    },
    shipped_date: Date,
    items: [orderItemSchema],
    
    // Etsy-specific fields
    receipt_id: String,
    etsy_is_shipped: Boolean,
    last_etsy_sync: Date,
    etsy_order_data: mongoose.Schema.Types.Mixed,
    
    // Shopify-specific fields
    shopify_order_number: String,
    shopify_fulfillment_status: String,
    last_shopify_sync: Date,
    shopify_order_data: mongoose.Schema.Types.Mixed
});

// Add a virtual to check if all items in the order are digital
orderSchema.virtual('is_all_digital').get(function() {
    return this.items.length > 0 && this.items.every(item => item.is_digital);
});

// Helper method to update status based on Etsy data
orderSchema.methods.updateFromEtsy = function(etsyData) {
    // Update shipping status
    this.etsy_is_shipped = etsyData.is_shipped;
    this.status = etsyData.is_shipped ? 'shipped' : 'unshipped';
    
    // Clear shipped date if not shipped
    if (!etsyData.is_shipped) {
        this.shipped_date = null;
    }
    
    // Update shipped_date from shipment notification
    if (etsyData.is_shipped && 
        etsyData.shipments && 
        etsyData.shipments.length > 0 && 
        etsyData.shipments[0].shipment_notification_timestamp) {
        const timestamp = etsyData.shipments[0].shipment_notification_timestamp;
        const newShippedDate = new Date(timestamp * 1000);
        
        // Only update if date is different or not set
        if (!this.shipped_date || this.shipped_date.getTime() !== newShippedDate.getTime()) {
            this.shipped_date = newShippedDate;
            console.log(`Updated shipped_date for ${this.receipt_id} to ${newShippedDate}`);
        }
    }

    this.last_etsy_sync = new Date();
    return this;
};

// Helper method to update status based on Shopify data
orderSchema.methods.updateFromShopify = function(shopifyData) {
    // Update shipping status based on Shopify fulfillment status
    this.shopify_fulfillment_status = shopifyData.fulfillment_status;
    this.status = shopifyData.fulfillment_status === 'fulfilled' ? 'shipped' : 'unshipped';
    
    // Clear shipped date if not shipped
    if (shopifyData.fulfillment_status !== 'fulfilled') {
        this.shipped_date = null;
    } else if (shopifyData.fulfillments && shopifyData.fulfillments.length > 0) {
        // Update shipped date from fulfillment
        const fulfillment = shopifyData.fulfillments[0];
        if (fulfillment.created_at) {
            const newShippedDate = new Date(fulfillment.created_at);
            
            // Only update if date is different or not set
            if (!this.shipped_date || this.shipped_date.getTime() !== newShippedDate.getTime()) {
                this.shipped_date = newShippedDate;
                console.log(`Updated shipped_date for Shopify order ${this.shopify_order_number} to ${newShippedDate}`);
            }
        }
    }

    this.last_shopify_sync = new Date();
    return this;
};

// Add debug helper before the model export
orderSchema.methods.debugShipmentDates = function() {
    if (this.marketplace === 'etsy' && this.etsy_order_data?.shipments?.[0]) {
        const shipment = this.etsy_order_data.shipments[0];
        return {
            receipt_id: this.receipt_id,
            current_shipped_date: this.shipped_date,
            etsy_timestamp: shipment.shipment_notification_timestamp,
            calculated_date: shipment.shipment_notification_timestamp ? 
                new Date(shipment.shipment_notification_timestamp * 1000) : null
        };
    } else if (this.marketplace === 'shopify' && this.shopify_order_data?.fulfillments?.[0]) {
        const fulfillment = this.shopify_order_data.fulfillments[0];
        return {
            order_number: this.shopify_order_number,
            current_shipped_date: this.shipped_date,
            shopify_created_at: fulfillment.created_at,
            calculated_date: fulfillment.created_at ? new Date(fulfillment.created_at) : null
        };
    }
    return null;
};

const Order = mongoose.model('Order', orderSchema);
module.exports = Order;