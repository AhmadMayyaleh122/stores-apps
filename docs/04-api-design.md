# API Design

## API Principles

The backend API will support three mobile apps:

- Admin Mobile App.
- Store Dashboard Mobile App.
- Customer Mobile App.

The API should be versioned, validated, consistent, and tenant-aware.

Recommended base path:

```text
/api/v1
```

Store-specific requests should include:

```http
x-store-slug: store-slug
```

Authenticated requests should include:

```http
Authorization: Bearer <access_token>
```

This document lists endpoint examples only. It does not define implementation details.

## Admin APIs

Admin APIs are used by platform admins and generally operate on the master database.

### Authentication

```http
POST /api/v1/admin/auth/login
POST /api/v1/admin/auth/logout
GET /api/v1/admin/auth/me
```

### Stores

```http
GET /api/v1/admin/stores
POST /api/v1/admin/stores
GET /api/v1/admin/stores/:storeId
PATCH /api/v1/admin/stores/:storeId
PATCH /api/v1/admin/stores/:storeId/status
PATCH /api/v1/admin/stores/:storeId/branding
```

### Subscription Plans

```http
GET /api/v1/admin/subscription-plans
POST /api/v1/admin/subscription-plans
GET /api/v1/admin/subscription-plans/:planId
PATCH /api/v1/admin/subscription-plans/:planId
```

### Store Features

```http
GET /api/v1/admin/stores/:storeId/features
PATCH /api/v1/admin/stores/:storeId/features
```

### Billing Subscriptions

```http
GET /api/v1/admin/stores/:storeId/billing-subscription
PATCH /api/v1/admin/stores/:storeId/billing-subscription
```

### Integrations

```http
GET /api/v1/admin/integrations
POST /api/v1/admin/integrations
PATCH /api/v1/admin/integrations/:integrationId
```

### Audit Logs

```http
GET /api/v1/admin/audit-logs
GET /api/v1/admin/stores/:storeId/audit-logs
```

## Store Dashboard APIs

Store Dashboard APIs are used by store owners and employees. These APIs require tenant resolution through `x-store-slug`.

### Authentication

```http
POST /api/v1/dashboard/auth/login
POST /api/v1/dashboard/auth/logout
GET /api/v1/dashboard/auth/me
```

### Store Configuration

```http
GET /api/v1/dashboard/store
PATCH /api/v1/dashboard/store/settings
GET /api/v1/dashboard/store/features
```

### Employees and Roles

```http
GET /api/v1/dashboard/employees
POST /api/v1/dashboard/employees
GET /api/v1/dashboard/employees/:employeeId
PATCH /api/v1/dashboard/employees/:employeeId
PATCH /api/v1/dashboard/employees/:employeeId/status

GET /api/v1/dashboard/roles
POST /api/v1/dashboard/roles
PATCH /api/v1/dashboard/roles/:roleId
GET /api/v1/dashboard/permissions
```

### Branches

```http
GET /api/v1/dashboard/branches
POST /api/v1/dashboard/branches
GET /api/v1/dashboard/branches/:branchId
PATCH /api/v1/dashboard/branches/:branchId
PATCH /api/v1/dashboard/branches/:branchId/status
```

### Categories and Products

```http
GET /api/v1/dashboard/categories
POST /api/v1/dashboard/categories
PATCH /api/v1/dashboard/categories/:categoryId

GET /api/v1/dashboard/products
POST /api/v1/dashboard/products
GET /api/v1/dashboard/products/:productId
PATCH /api/v1/dashboard/products/:productId
POST /api/v1/dashboard/products/:productId/images
DELETE /api/v1/dashboard/products/:productId/images/:imageId
```

### Product Options and Variants

```http
POST /api/v1/dashboard/products/:productId/options
PATCH /api/v1/dashboard/products/:productId/options/:optionId
POST /api/v1/dashboard/products/:productId/variants
PATCH /api/v1/dashboard/products/:productId/variants/:variantId
```

### Branch Inventory

```http
GET /api/v1/dashboard/branches/:branchId/inventory
PATCH /api/v1/dashboard/branches/:branchId/inventory/:inventoryId
PATCH /api/v1/dashboard/branches/:branchId/products/:productId/inventory
```

### Customers

```http
GET /api/v1/dashboard/customers
GET /api/v1/dashboard/customers/:customerId
GET /api/v1/dashboard/customers/:customerId/orders
```

### Orders

```http
GET /api/v1/dashboard/orders
GET /api/v1/dashboard/orders/:orderId
PATCH /api/v1/dashboard/orders/:orderId/status
GET /api/v1/dashboard/orders/:orderId/status-history
```

### Payments and Delivery

```http
GET /api/v1/dashboard/payments
GET /api/v1/dashboard/payments/:paymentId

GET /api/v1/dashboard/delivery-orders
GET /api/v1/dashboard/delivery-orders/:deliveryOrderId
PATCH /api/v1/dashboard/delivery-orders/:deliveryOrderId/status
```

### Notifications

```http
GET /api/v1/dashboard/notifications
POST /api/v1/dashboard/notifications
GET /api/v1/dashboard/notification-templates
PATCH /api/v1/dashboard/notification-templates/:templateId
```

### Analytics

```http
GET /api/v1/dashboard/analytics/overview
GET /api/v1/dashboard/analytics/orders
GET /api/v1/dashboard/analytics/products
```

## Customer APIs

Customer APIs are used by the Customer Mobile App. Browsing may be public, while checkout requires login.

### Store Public Configuration

```http
GET /api/v1/customer/store-config
GET /api/v1/customer/features
```

### Authentication

```http
POST /api/v1/customer/auth/register
POST /api/v1/customer/auth/login
POST /api/v1/customer/auth/logout
GET /api/v1/customer/auth/me
```

### Product Browsing

```http
GET /api/v1/customer/branches
GET /api/v1/customer/categories
GET /api/v1/customer/products
GET /api/v1/customer/products/:productId
GET /api/v1/customer/branches/:branchId/products
```

### Customer Profile and Addresses

```http
GET /api/v1/customer/profile
PATCH /api/v1/customer/profile
GET /api/v1/customer/addresses
POST /api/v1/customer/addresses
PATCH /api/v1/customer/addresses/:addressId
DELETE /api/v1/customer/addresses/:addressId
```

### Cart

```http
GET /api/v1/customer/cart
POST /api/v1/customer/cart/items
PATCH /api/v1/customer/cart/items/:cartItemId
DELETE /api/v1/customer/cart/items/:cartItemId
DELETE /api/v1/customer/cart
```

### Checkout and Orders

```http
POST /api/v1/customer/checkout
GET /api/v1/customer/orders
GET /api/v1/customer/orders/:orderId
GET /api/v1/customer/orders/:orderId/status-history
```

### Payments

```http
GET /api/v1/customer/payment-methods
POST /api/v1/customer/orders/:orderId/payment-proof
```

### Notifications

```http
GET /api/v1/customer/notifications
PATCH /api/v1/customer/notifications/:notificationId/read
POST /api/v1/customer/notification-tokens
DELETE /api/v1/customer/notification-tokens/:tokenId
```

## Standard Response Shape

Successful responses should be predictable:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

Error responses should be consistent:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": []
  }
}
```
