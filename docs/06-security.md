# Security

## Security Goals

The platform handles commercial store data, customer accounts, orders, payments metadata, employee permissions, and tenant configuration. Security must be treated as a core product requirement, not an afterthought.

The MVP should establish strong foundations for authentication, authorization, tenant isolation, validation, logging, and credential protection.

## Password Hashing

Passwords must never be stored as plain text.

Requirements:

- Hash passwords using a strong password hashing algorithm.
- Store only password hashes.
- Use per-password salts through the hashing library.
- Apply reasonable password rules for admins, employees, and customers.
- Never return password hashes through APIs.

Password reset and account recovery flows can be designed after the authentication foundation is stable.

## JWT Authentication

The MVP should use JWT access tokens for authenticated API requests.

Token usage:

```http
Authorization: Bearer <access_token>
```

Separate authentication contexts should exist for:

- Platform admins.
- Store owners and employees.
- Customers.

Tokens should contain only necessary claims, such as user ID, user type, role information if appropriate, and tenant context where relevant. Sensitive data should not be placed inside JWT payloads.

## Refresh Token Later

Refresh tokens are planned for a later phase.

Initial MVP work may start with short-lived access tokens and clear login/logout behavior. Before production launch, refresh token strategy should be reviewed and implemented if needed for user experience and security.

Refresh token design should consider:

- Secure storage on mobile devices.
- Rotation.
- Revocation.
- Device-level sessions.
- Logout from one device or all devices.

## Role-Based Access Control

The Store Dashboard must enforce role-based access control for store owners and employees.

Core concepts:

- Employees belong to a store.
- Employees are assigned roles.
- Roles are connected to permissions.
- API endpoints check permissions before performing protected actions.

Examples:

- Only permitted users can manage employees.
- Only permitted users can change product data.
- Only permitted users can update branch inventory.
- Only permitted users can update order status.

Platform admin permissions should be handled separately from store employee permissions.

## Tenant Isolation

Tenant isolation is a primary security requirement.

Rules:

- Each store has a separate physical PostgreSQL database.
- Store-specific requests must resolve the tenant using `x-store-slug`.
- Store Dashboard and Customer APIs must never query another store's database.
- Backend services must receive tenant context explicitly.
- Cross-tenant access must be prevented at the API and database connection layers.
- Logs should include tenant identifiers where useful, without exposing sensitive data.

The system should fail closed. If tenant resolution fails, the request should be rejected.

## Audit Logs

Audit logs should capture important platform and store actions.

Platform audit examples:

- Admin login.
- Store creation.
- Store status change.
- Subscription plan change.
- Feature override change.
- Integration setting update.

Store audit examples:

- Employee created or disabled.
- Role or permission changed.
- Product updated.
- Branch inventory changed.
- Order status changed.
- Coupon updated.

Audit records should include:

- Actor ID.
- Actor type.
- Action.
- Target entity.
- Timestamp.
- Tenant/store context where applicable.
- Relevant metadata.

## Encrypted Credentials

API keys, integration credentials, payment provider secrets, notification provider secrets, and database credentials must not be stored in plain text.

Requirements:

- Use environment variables for application secrets.
- Encrypt stored integration credentials.
- Restrict access to production secrets.
- Avoid logging secrets.
- Rotate secrets when needed.

## Input Validation

All external input must be validated before use.

Validation should cover:

- Request body.
- Query parameters.
- Path parameters.
- Headers such as `x-store-slug`.
- File uploads.

Validation goals:

- Reject malformed input early.
- Prevent unexpected data shapes.
- Protect database integrity.
- Produce clear error responses.

## Error Response Format

Errors should be consistent and should not expose internal implementation details.

Recommended format:

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

Common error codes:

- `VALIDATION_ERROR`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `TENANT_NOT_FOUND`
- `RESOURCE_NOT_FOUND`
- `CONFLICT`
- `INTERNAL_SERVER_ERROR`

Production errors should be logged internally while returning safe messages to clients.

## Additional Security Notes

- Use HTTPS in production.
- Apply rate limiting to authentication endpoints.
- Lock or throttle repeated failed login attempts.
- Validate uploaded file type and size.
- Avoid exposing stack traces.
- Use least-privilege database credentials.
- Keep dependencies updated once package installation begins.
- Review payment-related flows carefully before enabling real card processing.
