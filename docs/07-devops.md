# DevOps

## Development Environment

The project will start as a structured monorepo containing:

- `backend` for the future Node.js/NestJS API.
- `apps/admin-app` for the future Admin Mobile App.
- `apps/store-dashboard-app` for the future Store Dashboard Mobile App.
- `apps/customer-app` for the future Customer Mobile App.
- `shared` for shared types, constants, and validators.
- `docs` for planning and technical documentation.

No packages should be installed until the implementation phase begins.

Recommended local development setup later:

- Node.js LTS.
- Package manager selected consistently for the monorepo.
- PostgreSQL.
- Mobile development tools for React Native.
- Environment files for local configuration.

## PostgreSQL Setup Later

PostgreSQL will be required for:

- Master database.
- One physical database per store.

Planned local setup:

- Create one master database.
- Create one or more sample store databases.
- Store tenant connection metadata in the master database.
- Use migrations once the backend framework and ORM/query layer are selected.

The exact schema migration strategy should be decided during backend foundation work.

## Environment Variables

Environment variables should be used for configuration that changes between environments or contains secrets.

Expected variable categories:

- Application environment.
- API port.
- Master database connection.
- Tenant database connection rules.
- JWT secret.
- Password hashing settings if needed.
- File storage path or provider settings.
- Payment provider settings.
- Push notification provider settings.
- Logging level.

Example names for later planning:

```text
NODE_ENV
API_PORT
MASTER_DATABASE_URL
JWT_ACCESS_SECRET
FILE_STORAGE_DRIVER
FILE_STORAGE_BASE_URL
LOG_LEVEL
```

Do not commit real secrets to the repository.

## Backups

Backups are important because each store has its own database.

Backup strategy should include:

- Regular master database backups.
- Regular backups for every store database.
- Backup retention policy.
- Restore testing.
- Clear ownership for backup monitoring.
- Special handling for large stores.

The ability to restore one store without affecting other stores is a major advantage of the separate database model.

## Logging

The backend should produce structured logs suitable for debugging and production operations.

Logs should include:

- Request ID.
- Timestamp.
- Environment.
- Tenant/store ID or slug when applicable.
- User ID and user type when safe.
- Error code.
- Operation name.

Logs should not include:

- Passwords.
- JWTs.
- Payment secrets.
- Full card details.
- Private integration credentials.

## Deployment Notes

Production deployment will require:

- Backend API hosting.
- PostgreSQL hosting.
- File storage.
- Mobile app build and release process.
- Environment-specific configuration.
- Secure secret management.
- Monitoring and alerting.
- Backup automation.

The MVP can begin with a simple deployment model, but it should avoid decisions that make production hard later.

Recommended environment stages:

- Local.
- Development.
- Staging.
- Production.

Staging should resemble production closely enough to test tenant isolation, app configuration, order flows, and deployment procedures.

## Production Readiness Checklist

Before production launch:

- Backend API runs with production configuration.
- Master database migrations are repeatable.
- Store database migrations are repeatable.
- Tenant resolution is tested.
- Cross-tenant data access is prevented.
- Authentication and authorization are tested.
- Role-based permissions are enforced.
- Passwords are hashed.
- Secrets are stored securely.
- Integration credentials are encrypted.
- File uploads are validated.
- Backups are automated.
- Restore process is tested.
- Logs are structured and searchable.
- Errors return safe response messages.
- Mobile apps load dynamic store config.
- Push notification setup is verified.
- Payment flows are reviewed.
- Order placement and status updates are tested end to end.
- Basic monitoring and alerting are active.
- Operational documentation is available.
