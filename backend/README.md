# Backend API

Minimal NestJS TypeScript API foundation for the white-label mobile commerce platform.

This backend will later contain the platform APIs, tenant resolution, authentication, database access, and commerce modules. The existing module folders are intentionally preserved as empty boundaries until each feature is implemented.

## Setup

Install dependencies from inside the `backend` folder:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

## Development

Run the development server:

```bash
npm run start:dev
```

By default, the API uses:

```text
PORT=3000
```

## Health Check

Test the health endpoint:

```bash
curl http://localhost:3000/
```

Expected response:

```json
{
  "success": true,
  "message": "White-label commerce backend is running",
  "data": {
    "service": "backend-api",
    "status": "ok"
  }
}
```

Future API routes should use the global `/api` prefix.

## Available Scripts

```bash
npm run start
npm run start:dev
npm run build
npm run lint
npm run test
```

## Planned Later

- PostgreSQL connection.
- Prisma setup.
- Database schema and migrations.
- JWT authentication.
- Refresh tokens.
- Tenant resolver using `x-store-slug`.
- Master database and store database access.
- Business modules and API implementation.

No Prisma files, migrations, database tables, authentication logic, tenant database creation, or business module implementations are included yet.
