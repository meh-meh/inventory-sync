---
applyTo: "**"
---

# Etsy Inventory App - AI Coding Instructions

This document provides coding standards, domain knowledge, and preferences for AI assisting with the Etsy Inventory App project.

## 1. Project Overview

- **Purpose**: To manage inventory across Etsy and Shopify platforms.
- **Core Features**:
  - Fetching and displaying product/inventory data from Etsy and Shopify.
  - Synchronizing inventory levels between platforms.
  - Using order data to update inventory levels and provide a secondary source of truth.
  - API authentication.
  - Configuration settings.

## 2. Tech Stack

- **Backend**: Node.js, Express.js
- **Frontend**: Handlebars (hbs) for templating. (Specify any CSS frameworks like Bootstrap, Tailwind if used)
- **Database**: (Specify the database used, e.g., MongoDB, PostgreSQL - inferred from `config/database.js`)
- **APIs**: Etsy API v3, Shopify API
- **Key Libraries**: (List important npm packages, e.g., axios, passport, mongoose/sequelize, winston)

## 3. Coding Standards & Style

- **Language**: JavaScript (ES6+ syntax preferred).
- **Formatting**:
  - Prettier is used for code formatting. Refer to `.prettierrc` (or `package.json`) for configuration.
  - ESLint is used for linting (code quality rules). Refer to `eslint.config.mjs` for specific rules.
  - Run `npx prettier . --write` (or configure your editor) to format code.
  - Run `npx eslint . --fix` to fix linting issues.
- **Naming Conventions**:
  - Variables/Functions: `camelCase`
  - Classes: `PascalCase`
  - Constants: `UPPER_SNAKE_CASE`
  - Files: `kebab-case` (e.g., `auth-service.js`).
- **Comments**: Add JSDoc comments for functions and complex logic. Explain _why_, not just _what_.
- **Error Handling**: Use try-catch blocks for async operations, especially API calls. Log errors using the provided `logger.js`. Return meaningful error messages/status codes in API responses.
- **Security**: Sanitize user inputs. Store sensitive credentials securely (e.g., using environment variables, not hardcoded). Implement proper authentication and authorization checks (`middleware.js`, `auth-service.js`).

## 4. Domain Knowledge

- **Product**: Represents an item listed on Etsy or Shopify. Key fields might include SKU, title, description, price, quantity, images, variations. Note differences in product structures between Etsy (`Etsy_API_3.0.0.json`) and Shopify (`shopify-helpers.js`).
- **Inventory**: Refers to the stock level (quantity) of a product. Synchronization aims to keep this consistent across platforms.
- **Order**: Represents a customer purchase. Includes details like items, customer info, shipping address, status. (`models/order.js`)
- **Marketplace**: Refers to either Etsy or Shopify. Helper functions exist for platform-specific logic (`etsy-helpers.js`, `shopify-helpers.js`, `marketplace-helpers.js`).
- **Sync**: The process of updating data (primarily inventory) between Etsy and Shopify (`sync.js`).

## 5. API Usage

- **Etsy API**: Uses OAuth 2.0 for authentication (`auth.js`, `auth-service.js`). Be mindful of rate limits. Refer to `Etsy_API_3.0.0.json` for endpoints and schemas.
- **Shopify API**: Uses GraphQL for data fetching and mutations. Authentication is done via API keys. Refer to `shopify-helpers.js` for GraphQL queries and mutations.
- **Data Fetching**: Use async/await for API calls. Handle errors gracefully and log them using the logger.
- **Data Handling**: Transform data between Etsy and Shopify formats as needed. Handle potential discrepancies.

## 6. Key Files & Modules

- `server.js`: Main application entry point, sets up Express server and middleware.
- `config/database.js`: Database connection setup.
- `models/`: Defines data schemas/models (e.g., `product.js`, `order.js`).
- `routes/`: Defines API endpoints and connects them to controller logic.
- `utils/`: Contains helper functions and services (logging, auth, API interactions).
- `views/`: Handlebars templates for the UI. `layouts/main.hbs` is the main layout.

## 7. Testing

- (Describe your testing strategy. e.g., "Use Jest for unit tests.", "Place tests in a `tests/` directory.", "Focus on testing utility functions and API interactions.")
- `test-scripts/`: Contains scripts related to testing.
- For now, focus on unit tests for utility functions and API interactions and debugging. Integration tests for the entire app will be added later.

## 8. User Preferences

- Prefer functional components/modules where appropriate.
- Keep functions small and focused.
- Prioritize clear, readable code over overly clever solutions.
- Before suggesting changes, check for existing patterns in the codebase.
- If unsure about a specific implementation, ask for clarification or provide options with pros/cons.
- Before making edits, review your intended change for correctness and consistency with the existing codebase. Consider what bugs or issues might arise from the change.
