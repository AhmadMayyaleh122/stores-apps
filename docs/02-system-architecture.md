# System Architecture

## High-Level Architecture

The platform will be built as a mobile-first white-label SaaS commerce system.

Planned main components:

- Admin Mobile App.
- Store Dashboard Mobile App.
- Customer Mobile App.
- Backend API.
- Master PostgreSQL database.
- Separate physical PostgreSQL database per store.
- File storage for images, logos, and uploaded assets.
- Shared package for types, constants, and validators.

The mobile apps will communicate with the backend API over HTTPS. The backend will authenticate users, resolve tenant context, enforce authorization, validate requests, and route data operations to the correct database.

## Master Database vs Store Databases

### Master Database

The master database contains platform-level data that is shared across the SaaS operation.

Examples:

- Platform admins.
- Store registry.
- Store slug and tenant database connection metadata.
- Subscription plans.
- Plan features.
- Store enabled features.
- API integrations.
- Billing subscription records.
- Platform admin audit logs.

The master database should not store store-specific commerce records such as products, branch stock, customers, carts, or orders.

### Store Databases

Each store has a separate physical PostgreSQL database.

Each store database contains only that store's operational data:

- Employees and permissions.
- Branches.
- Categories and products.
- Branch inventory.
- Customers and addresses.
- Carts and orders.
- Payments and delivery orders.
- Notifications.
- Coupons.
- Store audit logs.

This model provides strong tenant isolation and makes it easier to back up, restore, migrate, or move individual stores later.

## Tenant Resolution Using `x-store-slug`

Store-specific requests should include the `x-store-slug` header.

Example:

```http
x-store-slug: demo-store
```

The backend request flow:

1. Receive a request.
2. Read `x-store-slug`.
3. Look up the store in the master database.
4. Validate that the store exists and is active.
5. Resolve the store database connection.
6. Attach tenant context to the request.
7. Execute store-specific logic against that store database only.

Admin platform APIs may not require `x-store-slug` when they operate on platform-level data. Store Dashboard and Customer APIs generally require it.

## File Storage Approach

Images, logos, and uploaded files should be stored outside PostgreSQL.

The database should store:

- File URL.
- File type.
- File size if needed.
- Original file name if needed.
- Ownership metadata.
- Upload timestamps.

Storage options can start with server-managed file storage and later move to object storage such as S3-compatible storage if scale or deployment requirements demand it.

This keeps databases smaller, simplifies backups, and avoids storing binary data in relational tables.

## Main Backend Modules

Planned backend modules:

- `auth`: authentication and token handling.
- `admin`: platform admin operations.
- `stores`: store registry and tenant metadata.
- `tenants`: tenant database resolution and connection management.
- `subscriptions`: plans, features, and subscriptions.
- `branches`: branch records and branch settings.
- `products`: categories, products, options, variants, and images.
- `inventory`: branch-level price and stock.
- `customers`: customer accounts and addresses.
- `carts`: cart and cart item management.
- `orders`: order placement and order lifecycle.
- `payments`: payment method and payment records.
- `delivery`: manual delivery orders first, third-party integrations later.
- `notifications`: push notifications first, other channels later.
- `analytics`: operational reporting and dashboards.
- `employees`: roles, permissions, and employee access.
- `files`: uploads, file metadata, and asset URLs.

## Request Flow Examples

### Customer Browses Products

1. Customer app sends `GET /customer/products` with `x-store-slug`.
2. Backend resolves the store from the master database.
3. Backend connects to the store database.
4. Backend returns public product catalog data.
5. Login is not required for browsing.

### Customer Places an Order

1. Customer logs in and receives an access token.
2. Customer app sends checkout request with `x-store-slug` and authorization token.
3. Backend validates customer identity and cart data.
4. Backend checks branch inventory.
5. Backend creates the order and order items in the store database.
6. Backend stores product and price snapshots in `order_items`.
7. Backend creates a payment record.
8. Backend creates delivery or pickup workflow records.
9. Backend queues or records a push notification.

### Store Owner Updates Branch Stock

1. Store Dashboard app sends request with `x-store-slug` and owner or employee token.
2. Backend resolves tenant database.
3. Backend checks role permissions.
4. Backend updates `branch_inventory`.
5. Backend writes a store audit log entry.

### Platform Admin Creates a Store

1. Admin app sends a platform admin request.
2. Backend validates platform admin access.
3. Backend creates a store record in the master database.
4. Backend provisions or registers a separate PostgreSQL database for the store.
5. Backend stores tenant metadata and initial branding settings.
6. Backend writes an admin audit log entry.
