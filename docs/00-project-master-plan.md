# White-Label Mobile Commerce Platform - Master Plan

## Project Overview

The product is a white-label SaaS mobile commerce platform. It allows the company to create branded mobile commerce apps for different stores without rebuilding the platform for every client.

Each store receives its own commercial configuration, including store name, logo, colors, branches, products, prices, stock, customers, orders, employees, permissions, and subscription plan.

The platform is mobile-first and app-only for the MVP. React Native will be used later for the mobile apps. Node.js with NestJS will be used later for the backend API. PostgreSQL will be used as the primary database technology.

## Users

### Platform Admin

Internal company user responsible for managing stores, plans, subscriptions, tenant setup, platform settings, and operational support.

### Store Owner

Business owner responsible for configuring the store, managing branches, products, employees, inventory, orders, and customer activity.

### Store Employee

Store staff member with limited access based on role and permissions. Employees may manage orders, products, inventory, or branch operations depending on assigned permissions.

### Customer

End user who browses products, creates an account, adds items to cart, places pickup or delivery orders, and receives notifications.

## Apps

### Admin Mobile App

Used by platform admins to create and manage stores, subscription plans, tenant settings, app branding, integrations, and platform-level audit activity.

### Store Dashboard Mobile App

Used by store owners and employees to manage daily store operations, including branches, products, branch-level prices and stock, orders, employees, and customer records.

### Customer Mobile App

Used by customers to browse a store catalog, view products, manage carts, place orders, choose delivery or pickup, pay using supported payment methods, and track order status.

## Architecture Summary

The platform will use a multi-tenant architecture with a master database and separate physical PostgreSQL databases per store.

The master database stores platform-level data such as store records, subscription plans, billing subscriptions, tenant metadata, enabled features, admin users, integrations, and audit logs.

Each store database stores that store's operational commerce data, including employees, roles, branches, categories, products, inventory, customers, carts, orders, payments, delivery records, notifications, coupons, and store audit logs.

Tenant resolution will use the `x-store-slug` request header. The backend will resolve the store from the master database, load the tenant database connection, and execute store-specific operations only against that store's database.

Images and logos will be stored on server file storage or external file storage. Databases will store URLs and metadata only, not binary image files.

## MVP Scope

The MVP should prove that the platform can operate multiple stores with independent branding, data, products, customers, and orders.

Included in MVP:

- Manual store creation by platform admins.
- Subscription plans: Trial, Basic, and Pro.
- Store branding: name, logo URL, colors, and enabled features.
- Product-only commerce, with no service booking.
- Multiple branches per store.
- Branch-level price and stock.
- Guest product browsing.
- Customer login required for checkout.
- Customer cart and order placement.
- Delivery and pickup order types.
- Payment methods: cash, card, and bank transfer.
- Manual delivery management.
- Push notifications first.
- Store owner employee management with roles and permissions.

Excluded from MVP:

- Third-party delivery integration.
- SMS, email, and WhatsApp notifications.
- Customer wallet.
- Automated store self-signup.
- Native app generation pipeline.
- Advanced reporting, forecasting, or marketing automation.

## Development Phases

### Phase 1: Planning and Structure

Create the monorepo structure, documentation, module boundaries, and high-level technical decisions before implementation begins.

### Phase 2: Backend Foundation

Initialize the backend framework, configuration structure, database connection strategy, tenant resolution, authentication foundation, validation patterns, and shared API conventions.

### Phase 3: Master Platform Features

Implement platform admin features for managing stores, plans, features, subscriptions, tenant metadata, and audit logs.

### Phase 4: Store Commerce Core

Implement store database schema and APIs for branches, employees, roles, categories, products, branch inventory, customers, carts, orders, payments, and notifications.

### Phase 5: Mobile App Foundations

Initialize React Native apps and shared UI patterns. Connect each app to the backend APIs and load dynamic branding and enabled feature configuration.

### Phase 6: MVP Stabilization

Complete end-to-end flows, improve validation and error handling, add logs, test core journeys, and prepare a deployable production candidate.

### Phase 7: Post-MVP Extensions

Add third-party delivery, SMS/email/WhatsApp notifications, stronger analytics, billing automation, app publishing workflows, and optional store self-service onboarding.

## Definition of Success for MVP

The MVP is successful when:

- A platform admin can manually create and configure a store.
- Each store operates on its own physical PostgreSQL database.
- Store data is isolated from other stores.
- Store owners can manage branches, employees, roles, products, prices, stock, and orders.
- Customers can browse products as guests.
- Customers can log in, checkout, and place delivery or pickup orders.
- Orders preserve product and price snapshots.
- The platform supports Trial, Basic, and Pro plans.
- Store branding can be loaded dynamically by mobile apps.
- The system has basic audit logs, validation, error handling, and operational logging.
