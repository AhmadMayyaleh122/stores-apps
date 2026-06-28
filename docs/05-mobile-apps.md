# Mobile Apps

## Mobile App Strategy

The platform will provide three mobile apps:

- Admin Mobile App.
- Store Dashboard Mobile App.
- Customer Mobile App.

All apps are planned for React Native later. This phase only defines documentation and screen planning.

The product is mobile-only for the MVP. No web dashboard is planned for the initial version.

## Admin Mobile App Screens

The Admin Mobile App is for internal platform operators.

Planned screens:

- Login.
- Admin profile.
- Stores list.
- Create store.
- Store details.
- Store branding settings.
- Store status management.
- Subscription plans list.
- Plan details.
- Store subscription management.
- Store feature management.
- API integrations.
- Billing subscription overview.
- Admin audit logs.
- Platform support notes or operational notes.

Main purpose:

- Manually create and manage stores.
- Configure tenant metadata.
- Assign Trial, Basic, or Pro plans.
- Control enabled features.
- Monitor platform-level operations.

## Store Dashboard Mobile App Screens

The Store Dashboard Mobile App is for store owners and employees.

Planned screens:

- Login.
- Dashboard overview.
- Store settings.
- Branches list.
- Branch details.
- Employees list.
- Create employee.
- Employee details.
- Roles and permissions.
- Categories list.
- Products list.
- Create product.
- Product details.
- Product images.
- Product options and variants.
- Branch inventory.
- Orders list.
- Order details.
- Update order status.
- Delivery orders.
- Customers list.
- Customer details.
- Coupons.
- Notifications.
- Notification templates.
- Analytics overview.
- Account settings.

Main purpose:

- Manage daily store operations.
- Control products, prices, and stock by branch.
- Process pickup and delivery orders.
- Manage employees using role-based permissions.

## Customer Mobile App Screens

The Customer Mobile App is for end users shopping from a specific store.

Planned screens:

- Store splash or loading screen.
- Home.
- Branch selection.
- Categories.
- Product list.
- Product details.
- Cart.
- Login.
- Register.
- Customer profile.
- Customer addresses.
- Checkout.
- Payment method selection.
- Order confirmation.
- Orders list.
- Order details.
- Notifications.
- Account settings.

Main purpose:

- Browse products as a guest.
- Log in before checkout.
- Place delivery or pickup orders.
- Receive order updates through push notifications.

## Shared UI and Components

The apps should eventually share common UI and utility patterns where practical.

Possible shared areas:

- Form inputs.
- Buttons.
- Loading states.
- Empty states.
- Error states.
- Product cards.
- Order status labels.
- Price formatting.
- Date formatting.
- Validation helpers.
- API client conventions.
- Theme tokens.

Shared code should avoid forcing all apps into the same layout. The Admin app, Store Dashboard app, and Customer app have different users and workflows, so shared components should be useful but not restrictive.

## White-Label Dynamic Config

The Customer Mobile App should load store-specific configuration dynamically.

Dynamic config should include:

- Store name.
- Logo URL.
- Primary color.
- Secondary color.
- Accent color.
- Default branch behavior.
- Enabled features.
- Available payment methods.
- Delivery and pickup availability.
- Notification settings.

The Store Dashboard app may also load store branding and enabled features, but its interface should prioritize operational clarity over heavy branding.

The Admin app should use company/platform branding, not client store branding.

## Feature Availability

Feature visibility should be controlled by subscription plan and store-level feature settings.

Examples:

- Coupons may be available only on selected plans.
- Advanced analytics may be Pro-only.
- Multiple branch limits may depend on plan.
- Certain integrations may be enabled per store.

The mobile apps should hide or disable features that are not available for the current store rather than exposing actions that will fail later.

## MVP Mobile Priorities

Admin app priorities:

- Admin login.
- Create and manage stores.
- Assign plans and features.
- Manage branding basics.

Store Dashboard priorities:

- Owner and employee login.
- Branch management.
- Product and inventory management.
- Order management.
- Employee roles and permissions.

Customer app priorities:

- Dynamic store config.
- Guest browsing.
- Customer login and registration.
- Cart.
- Checkout.
- Delivery and pickup orders.
- Push notification token registration.
