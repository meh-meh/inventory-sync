# Etsy API Usage in Etsy Inventory App

This document lists all Etsy API interactions in the codebase, including endpoint, usage, and file/function references. Use this as a reference for refactoring, debugging, and ensuring global concurrency control.

---

## 1. utils/etsy-helpers.js

- **etsyFetch**
  - Centralized function for all Etsy API HTTP requests.
  - Handles rate limiting, retries, error handling, and logging.
  - Used throughout the app for all Etsy API calls.

- **getShopId**
  - Endpoint: `/application/users/me`
  - Fetches the shop ID for the authenticated user.

- **getShippingProfiles**
  - Endpoint: `/application/shops/{shop_id}/shipping-profiles`
  - Fetches shipping profiles for the connected shop.

---

## 2. routes/sync.js

- **fetchAllListings** (Etsy product sync)
  - Endpoint: `/application/shops/{shop_id}/listings`
  - Fetches all product listings in bulk, paginated and by state.

- **syncEtsyOrders**
  - Endpoint: `/application/shops/{shop_id}/receipts`
  - Fetches all orders/receipts in bulk, paginated.

---

## 3. routes/orders.js

- **Order status sync endpoint** (`router.post('/:id/sync-status', ...)`)
  - Endpoint: `/application/shops/{shop_id}/receipts/{receipt_id}`
  - Fetches a single order/receipt for status update.

---

## 4. routes/settings.js

- **Shop name fetch**
  - Endpoint: `/application/shops/{shop_id}`
  - Fetches shop details (e.g., shop name) for display in settings.

---

## 5. routes/auth.js

- **OAuth token exchange**
  - Endpoint: `/v3/public/oauth/token`
  - Exchanges authorization code for access token.

---

## 6. server.js

- **Ping endpoint**
  - Endpoint: `/v3/application/openapi-ping`
  - Tests connectivity to the Etsy API.

---

## Summary Table

| File                  | Function/Route/Usage                | Etsy API Endpoint(s) Used                                 |
|-----------------------|-------------------------------------|----------------------------------------------------------|
| utils/etsy-helpers.js | etsyFetch, getShopId, getShippingProfiles | /users/me, /shipping-profiles, (all via etsyFetch)       |
| routes/sync.js        | fetchAllListings, syncEtsyOrders    | /listings, /receipts                                     |
| routes/orders.js      | POST /:id/sync-status               | /receipts/{receipt_id}                                   |
| routes/settings.js    | Shop name fetch                     | /shops/{shop_id}                                         |
| routes/auth.js        | OAuth token exchange                | /v3/public/oauth/token                                   |
| server.js             | /ping endpoint                      | /v3/application/openapi-ping                             |

---

**Note:**

- All direct Etsy API calls should use `etsyFetch` (and now `etsyRequest` for concurrency control).
- If you want to ensure all Etsy API calls are tracked, wrap all `etsyFetch` usages in `etsyRequest`, including those in helpers and routes.
