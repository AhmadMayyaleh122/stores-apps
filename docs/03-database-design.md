# Database Design

## Database Strategy

The platform uses PostgreSQL with two database layers:

- Master database for platform-level SaaS data.
- Separate physical PostgreSQL database per store for store-specific commerce data.

This design prioritizes tenant isolation, operational clarity, and the ability to back up, restore, migrate, or scale stores independently.

## Master Database Tables

### `admins`

Stores internal platform admin accounts.

Typical data:

- Name.
- Email.
- Password hash.
- Status.
- Last login timestamp.

### `stores`

Stores the platform registry of client stores.

Typical data:

- Store name.
- Store slug.
- Logo URL.
- Brand colors.
- Status.
- Tenant database connection metadata.
- Current subscription plan reference.
- Created and updated timestamps.

### `subscription_plans`

Defines available commercial plans such as Trial, Basic, and Pro.

Typical data:

- Plan name.
- Description.
- Price.
- Billing period.
- Status.

### `plan_features`

Defines which features belong to each subscription plan.

Typical data:

- Plan ID.
- Feature key.
- Feature label.
- Limit value if applicable.
- Enabled status.

### `store_features`

Stores feature overrides or enabled features for a specific store.

This allows the platform to customize access per store when needed without changing the global plan definition.

### `api_integrations`

Stores platform-level integration configuration metadata.

Examples:

- Payment provider metadata.
- Notification provider metadata.
- Delivery provider metadata for future phases.

Sensitive credentials should be encrypted and never stored as plain text.

### `billing_subscriptions`

Stores billing and subscription lifecycle records for stores.

Typical data:

- Store ID.
- Plan ID.
- Subscription status.
- Trial start and end date.
- Billing start date.
- Renewal date.
- Cancellation date.

### `admin_audit_logs`

Records platform admin activity.

Examples:

- Store created.
- Plan changed.
- Store status changed.
- Integration updated.
- Feature enabled or disabled.

Audit logs support accountability, support operations, and incident investigation.

## Store Database Tables

### `employees`

Stores store owner and employee accounts for the Store Dashboard app.

### `roles`

Defines store-level roles such as owner, manager, cashier, inventory manager, or custom roles.

### `permissions`

Defines individual permission keys used by role-based access control.

Examples:

- `products.read`
- `products.write`
- `orders.manage`
- `inventory.update`
- `employees.manage`

### `role_permissions`

Join table connecting roles to permissions.

### `branches`

Stores physical or operational store branches.

Each branch can have its own address, contact details, working hours, order availability, delivery settings, prices, and stock.

### `categories`

Stores product category hierarchy or grouping.

### `products`

Stores core product records.

Product records should contain shared product information such as name, description, category, base status, and general product metadata. Branch-specific price and stock should not live here.

### `product_images`

Stores image URLs and metadata for product photos.

The binary image files are stored in file storage. The database stores URLs only.

### `product_options`

Stores option groups for configurable products.

Examples:

- Size.
- Color.
- Packaging.

### `product_option_values`

Stores option values that belong to product options.

Examples:

- Small, Medium, Large.
- Red, Black, White.

### `product_variants`

Stores sellable product variants created from option combinations.

Examples:

- Black T-shirt, Large.
- 500ml Bottle Pack.

### `branch_inventory`

Stores branch-level commercial availability for products or variants.

This table is important because price and stock are per branch, not global.

Typical data:

- Branch ID.
- Product ID or variant ID.
- Price.
- Sale price if applicable.
- Available stock quantity.
- Low stock threshold.
- Availability status.

Example: the same product may cost different amounts in two branches or be available in one branch but out of stock in another. Keeping this in `branch_inventory` prevents incorrect global pricing and supports real branch operations.

### `customers`

Stores customer accounts for the Customer Mobile App.

### `customer_addresses`

Stores customer delivery addresses.

### `carts`

Stores active or historical customer cart headers.

### `cart_items`

Stores products or variants added to a cart, including selected branch and quantity.

### `orders`

Stores order headers.

Typical data:

- Customer ID.
- Branch ID.
- Order type: delivery or pickup.
- Status.
- Payment method.
- Totals.
- Delivery or pickup details.
- Created timestamp.

### `order_items`

Stores the products purchased in an order.

`order_items` must store product and price snapshots because product names, images, options, variants, and prices can change after an order is placed.

Snapshot data protects order history, invoices, support workflows, refunds, and reporting. An old order should still show what the customer actually bought and the price they agreed to pay at checkout.

### `order_status_history`

Stores a timeline of order status changes.

Examples:

- Pending.
- Accepted.
- Preparing.
- Ready for pickup.
- Out for delivery.
- Completed.
- Cancelled.

### `payments`

Stores payment records for cash, card, and bank transfer.

The MVP records payment intent and status. Full payment provider integration can be added later.

### `delivery_orders`

Stores delivery-specific workflow data.

The MVP supports manual delivery. Third-party delivery provider fields can be added later.

### `notifications`

Stores notification records sent or scheduled for customers, employees, or owners.

### `notification_templates`

Stores reusable notification templates for order updates and operational messages.

### `coupons`

Stores discount codes and promotional rules.

Coupons can be limited by status, date range, branch, customer, or product rules in future phases.

### `customer_notification_tokens`

Stores push notification tokens for customer devices.

### `store_audit_logs`

Records store-level actions by owners and employees.

Examples:

- Product updated.
- Stock changed.
- Order status changed.
- Employee created.
- Permission changed.

## Notes for Later Schema Design

- All tables should use stable primary keys.
- Common audit fields should include `created_at`, `updated_at`, and optionally `deleted_at`.
- Store databases should support soft deletion for records that affect historical reports.
- Foreign keys should be used where they improve data integrity.
- Indexes should be planned around common queries such as product browsing, branch inventory lookup, customer orders, and order status filtering.
