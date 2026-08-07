import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

const tenantPrismaRoot = path.resolve(
  __dirname,
  '../../../../prisma/tenant',
);
const migrationName = '20260807193344_store_owner_foundation';

describe('tenant Store Owner Prisma foundation', () => {
  let schema: string;
  let migration: string;

  beforeAll(async () => {
    [schema, migration] = await Promise.all([
      readFile(path.join(tenantPrismaRoot, 'schema.prisma'), 'utf8'),
      readFile(
        path.join(
          tenantPrismaRoot,
          'migrations',
          migrationName,
          'migration.sql',
        ),
        'utf8',
      ),
    ]);
  });

  it('defines the employee status enum and tenant models', () => {
    expect(schema).toMatch(
      /enum EmployeeStatus\s*{\s*PENDING_ACTIVATION\s+ACTIVE\s+INACTIVE\s+SUSPENDED\s*}/,
    );
    expect(schema).toMatch(/model Role\s*{[\s\S]*?@@map\("roles"\)\s*}/);
    expect(schema).toMatch(
      /model Employee\s*{[\s\S]*?@@map\("employees"\)\s*}/,
    );
    expect(migration).toContain(
      'CREATE TYPE "EmployeeStatus" AS ENUM (\'PENDING_ACTIVATION\', \'ACTIVE\', \'INACTIVE\', \'SUSPENDED\');',
    );
    expect(migration).toContain('CREATE TABLE "roles"');
    expect(migration).toContain('CREATE TABLE "employees"');
  });

  it('uses native UUIDs, expected uniqueness, and lookup indexes', () => {
    expect(migration).toContain('"id" UUID NOT NULL');
    expect(migration).toContain('"role_id" UUID NOT NULL');
    expect(migration).toContain('"master_store_id" UUID');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "employees_email_key" ON "employees"("email");',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "employees_master_store_id_key" ON "employees"("master_store_id");',
    );
    expect(migration).toContain(
      'CREATE INDEX "employees_role_id_idx" ON "employees"("role_id");',
    );
    expect(migration).toContain(
      'CREATE INDEX "employees_status_idx" ON "employees"("status");',
    );
  });

  it('enforces a single store owner with a Master Store identity', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "employees_single_store_owner_key"\s+ON "employees" \("is_store_owner"\)\s+WHERE "is_store_owner" = true;/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT "employees_store_owner_master_store_id_check"\s+CHECK \(\s*\("is_store_owner" = true AND "master_store_id" IS NOT NULL\)\s+OR \("is_store_owner" = false AND "master_store_id" IS NULL\)\s*\);/,
    );
  });

  it('requires canonical employee email values', () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT "employees_canonical_email_check"\s+CHECK \(\s*"email" = lower\(btrim\("email"\)\)\s+AND length\("email"\) > 0\s*\);/,
    );
  });

  it('restricts deleting a role that is assigned to an employee', () => {
    expect(migration).toContain(
      'CONSTRAINT "employees_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
  });

  it('does not introduce authentication or invitation columns', () => {
    const employeeTable = migration.match(
      /CREATE TABLE "employees" \(([\s\S]*?)\n\);/,
    );

    expect(employeeTable).not.toBeNull();
    expect(employeeTable?.[1]).not.toMatch(
      /password|credential|invitation|refresh[_ ]?token/i,
    );
  });
});
