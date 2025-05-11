# Etsy Inventory Manager

A Node.js application for managing Etsy inventory and orders across multiple marketplaces.

## Prerequisites

- Node.js 14 or higher
- MongoDB installed and running locally
- An Etsy Developer account with API access

## Setup

1. Install dependencies:

    ```bash
    npm install
    ```

2. Create a `.env` file with your Etsy API credentials (see `.env.example` for required fields)
3. Make sure MongoDB is running locally on the default port (27017)

## Project Structure

```plaintext
├── models/             # Database models
│   ├── order.js        # Order model definition
│   └── product.js      # Product model definition
├── routes/             # Route handlers
│   ├── auth.js         # Authentication routes
│   ├── inventory.js    # Inventory management routes
│   ├── orders.js       # Order management routes
│   ├── settings.js     # Application settings routes
│   └── sync.js         # Data synchronization routes
├── utils/              # Helper functions
│   ├── etsy-helpers.js # Etsy API helper functions
│   └── logger.js       # Logging utility
├── views/              # Handlebars templates
│   ├── layouts/        # Layout templates
│   └── *.hbs           # View templates
└── server.js           # Main application file
```

## Starting the Server

1. Kill any existing server instances:

    ```bash
    taskkill /F /IM node.exe
    ```

2. Start the server:

    ```bash
    node server.js
    ```

The server will be available at <http://localhost:3003>

## Features

- Sync inventory with Etsy
- Track order status and shipping
- Manage inventory levels
- View order details and history
- Filter orders by status (unshipped, shipped, canceled)
- Auto-refresh of Etsy OAuth tokens
- Support for physical and digital items
- Product image carousel in product details view
- Raw data inspection for advanced users

## Progress Summary

### Recently Completed

- [x] Moved to modular code structure with separate route files
- [x] Cleaned up debugging endpoints and consolidated helper functions
- [x] Fixed order status syncing with Etsy
- [x] Added proper handling of canceled orders
- [x] Implemented collapsible sections in orders view
- [x] Fixed digital/physical item filtering
- [x] Improved error handling and logging
- [x] Added missing Handlebars helpers ('length', 'lt')
- [x] Fixed image display in product details carousel
- [x] Enhanced JSON data display with improved depth handling
- [x] Optimized data processing for large objects

### Short-term Tasks

- [ ] Implement Shopify order sync
- [ ] Add bulk order status sync functionality
- [ ] Add order notes/comments feature
- [ ] Implement order search functionality
- [ ] Add order export functionality (CSV/Excel)
- [ ] Add additional Handlebars helpers for template flexibility

### Long-term Goals

- [ ] Add support for additional marketplaces (Amazon, eBay)
- [ ] Implement real-time order notifications
- [ ] Add inventory forecasting
- [ ] Create mobile-optimized interface
- [ ] Add barcode scanning support
- [ ] Implement automated inventory reconciliation
- [ ] Add support for multiple Etsy shops
- [ ] Create detailed reporting dashboard
- [ ] Add support for printing shipping labels
- [ ] Implement inventory location tracking

## Recent Refactoring Improvements

This application has recently been refactored to improve code organization and maintainability:

### Completed Refactoring

- [x] Centralized authentication token management in a dedicated service
- [x] Improved error handling with consistent logging
- [x] Reorganized server.js for better code organization
- [x] Created a unified database connection module
- [x] Added JSDoc documentation throughout the codebase
- [x] Separated Handlebars helpers into their own module
- [x] Improved route organization with proper separation of concerns

### Next Steps for Refactoring

- [ ] Add unit tests for the auth service module
- [ ] Implement a simple caching layer to prevent unnecessary database queries
- [ ] Add token status information to the dashboard UI (valid until time)
- [ ] Create a "force refresh" option in settings for manual token refreshing
- [ ] Convert to TypeScript for better type safety
- [ ] Implement environment-specific configuration files
- [ ] Create a centralized error handling middleware
- [ ] Add automated tests for critical functionality
- [ ] Further refactor route handlers for consistency

## Handlebars Helpers

The application uses the following Handlebars helpers:

- `json`: Safely converts objects to JSON strings with formatting
- `formatDate`: Formats date objects to local date strings
- `multiply`: Multiplies two numbers
- `divide`: Divides first number by second number
- `eq`: Checks if two values are equal
- `lt`: Checks if first value is less than second value
- `length`: Returns the length of an array

## Development Notes

- Use semantic commits for version control
- Run tests before submitting pull requests
- Keep dependencies up to date
- Follow the established code organization pattern when adding new features
- After making template changes, always restart the server

## Troubleshooting

### Common Issues

#### Missing Helpers

If you encounter a "Missing helper" error, you may need to add a new Handlebars helper in server.js.

#### Image Display Problems

If images aren't displaying properly, check the following:

1. Ensure image URLs are correctly formatted in the database
2. Verify the correct property is being used in the template (e.g., `url` instead of `url_fullxfull`)
3. Check browser console for 404 errors on image requests

#### Data Depth Issues

If you see ``[Max Depth Reached]`` in your data, the JSON helper may be truncating nested objects.
Adjust the maxDepth parameter in the JSON helper or add special handling for specific fields.

## MongoDB Management

### Starting MongoDB

1. Open Command Prompt as Administrator
2. Start the MongoDB service:

    ```bash
    net start MongoDB
    ```

### Stopping MongoDB

1. Open Command Prompt as Administrator
2. Stop the MongoDB service:

    ```bash
    net stop MongoDB
    ```

### Checking MongoDB Status

1. Open Command Prompt as Administrator
2. List running services:

    ```bash
    Get-Service -Name MongoDB -ErrorAction SilentlyContinue
    ```

### Further Troubleshooting

If MongoDB won't start:

1. Check if the service is installed:

    ```bash
    Get-Service -Name MongoDB -ErrorAction SilentlyContinue
    ```

2. If not found, install MongoDB as a service:

    ```bash
    "C:\Program Files\MongoDB\Server\{version}\bin\mongod.exe" --config "C:\Program Files\MongoDB\Server\{version}\bin\mongod.cfg" --install
    ```

    Replace {version} with your MongoDB version (e.g., 6.0)

**Note:** These commands require Administrator privileges. Right-click Command Prompt and select "Run as Administrator".

### Sample Data Prep

You can try running a query like the one below at a timestamp where you'll gather orders of multiple statuses to collect some test data. 

``` graphql
query GetOrders($numGet: Int!, $cursor: String) {
  orders(query: "created_at:>=1745798400", first: $numGet, after: $cursor) {
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
      fulfillments(first: 5) {
        id
        status
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
    }
  }
}

{
  "numGet": 20,
  "cursor": null
}
```
