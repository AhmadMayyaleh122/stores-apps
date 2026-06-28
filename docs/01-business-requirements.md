# Business Requirements

## Business Goal

Build a commercial white-label mobile commerce SaaS platform that allows the company to launch branded mobile commerce solutions for different stores efficiently and repeatedly.

The platform should reduce duplicate development work, support multiple client stores, and provide a maintainable foundation for subscription-based revenue.

## Target Customers

The primary customers are stores that sell physical products and need mobile commerce without building their own custom app from scratch.

Target store categories may include:

- Retail shops.
- Grocery and mini-market stores.
- Fashion and accessories stores.
- Electronics stores.
- Specialty product stores.
- Local businesses with multiple branches.

The MVP focuses on product sales only. Service booking, appointment scheduling, and marketplace behavior are outside the initial scope.

## User Types

### Platform Admin

Internal company operator who manages stores, subscriptions, plans, enabled features, integrations, and platform-level audit records.

Primary responsibilities:

- Create stores manually.
- Assign subscription plans.
- Configure store branding and tenant metadata.
- Enable or disable feature access.
- Monitor platform-level activity.
- Support store owners.

### Store Owner

Client-side business owner who manages the store's commerce operations.

Primary responsibilities:

- Manage branches.
- Manage employees and permissions.
- Manage categories, products, images, options, variants, prices, and stock.
- Review customers and orders.
- Handle delivery and pickup workflows.
- Configure operational store settings.

### Store Employee

Store staff member with access limited by assigned role and permissions.

Primary responsibilities may include:

- Process orders.
- Update order status.
- Manage branch stock.
- Manage products if permitted.
- View customer information if permitted.

### Customer

End user who shops from a store's mobile app.

Primary actions:

- Browse products as a guest.
- Register or log in before checkout.
- Add products to cart.
- Select delivery or pickup.
- Choose a payment method.
- Place orders.
- Receive push notifications.

## Main Business Rules

- Stores are created manually by platform admins.
- Each store has its own name, logo, colors, settings, branches, products, prices, stock, orders, employees, and customers.
- Each store uses a separate physical PostgreSQL database.
- Products are sold through store branches.
- Price and stock are per branch, not global.
- Customers may browse products without logging in.
- Customers must log in before checkout.
- Supported order types are delivery and pickup.
- Supported MVP payment methods are cash, card, and bank transfer.
- The platform does not support customer wallets in the MVP.
- Delivery is managed manually first.
- Third-party delivery integrations are planned for later.
- Push notifications are the first notification channel.
- SMS, email, and WhatsApp notifications are planned for later.
- Store owners can create employees and assign role-based permissions.
- Databases store image and logo URLs only. Binary files are stored separately.

## Subscription Plans

### Trial

Temporary plan used to onboard and evaluate a store.

Expected characteristics:

- Limited duration.
- Limited feature set.
- Suitable for demos and early client validation.

### Basic

Entry-level paid plan for smaller stores.

Expected characteristics:

- Core catalog and order management.
- Limited advanced features.
- Suitable for single-store or simple branch operations.

### Pro

Higher-level paid plan for stores with more operational needs.

Expected characteristics:

- More advanced feature access.
- Better support for multiple branches and employee permissions.
- Suitable for stores with larger product catalogs and order volume.

Final limits, pricing, and feature matrix should be defined before billing implementation.

## MVP Business Scope

The MVP should focus on proving the platform can manage real store commerce workflows with strong tenant separation.

In scope:

- Platform-admin-created stores.
- Plan assignment and enabled feature tracking.
- Dynamic store branding.
- Product catalog management.
- Product images, options, values, and variants.
- Multiple branches.
- Branch-level price and stock.
- Employee roles and permissions.
- Guest browsing.
- Customer account checkout.
- Cart management.
- Delivery and pickup orders.
- Cash, card, and bank transfer payment records.
- Manual delivery operations.
- Push notification records and tokens.
- Operational audit logs.

Out of scope for MVP:

- Store self-registration.
- Automated app publishing.
- Wallet balance.
- Service scheduling.
- Marketplace across multiple stores.
- Third-party delivery automation.
- Full billing automation.
- SMS, email, and WhatsApp sending.
