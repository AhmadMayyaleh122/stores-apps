import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

const tenantPrismaRoot = path.resolve(__dirname, '../../../../prisma/tenant');
const migrationName = '20260815220000_store_auth_refresh_sessions';

describe('tenant Store authentication refresh-session schema', () => {
  let schema: string;
  let migration: string;

  beforeAll(async () => {
    [schema, migration] = await Promise.all([
      readFile(path.join(tenantPrismaRoot, 'schema.prisma'), 'utf8'),
      readFile(
        path.join(tenantPrismaRoot, 'migrations', migrationName, 'migration.sql'),
        'utf8',
      ),
    ]);
  });

  it('defines a minimal EmployeeRefreshSession relation with cascade deletion', () => {
    expect(schema).toMatch(
      /model EmployeeRefreshSession\s*{[\s\S]*?@@map\("employee_refresh_sessions"\)\s*}/,
    );
    expect(schema).toMatch(/refreshSessions\s+EmployeeRefreshSession\[\]/);
    expect(migration).toContain('CREATE TABLE "employee_refresh_sessions"');
    expect(migration).toContain(
      'CONSTRAINT "employee_refresh_sessions_employee_id_fkey"',
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("employee_id"\) REFERENCES "employees"\("id"\)\s+ON DELETE CASCADE ON UPDATE CASCADE;/,
    );
  });

  it('stores only a fixed-size hash and security-relevant timestamps', () => {
    expect(schema).toMatch(
      /refreshTokenHash\s+Bytes\s+@unique\(map: "employee_refresh_sessions_refresh_token_hash_key"\)\s+@map\("refresh_token_hash"\)\s+@db\.ByteA/,
    );
    expect(migration).toContain('"refresh_token_hash" BYTEA NOT NULL');
    expect(migration).toMatch(
      /ADD CONSTRAINT "employee_refresh_sessions_refresh_token_hash_length_check"\s+CHECK \(octet_length\("refresh_token_hash"\) = 32\);/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT "employee_refresh_sessions_expiry_order_check"\s+CHECK \("expires_at" > "issued_at"\);/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT "employee_refresh_sessions_revoked_at_check"\s+CHECK \("revoked_at" IS NULL OR "revoked_at" >= "issued_at"\);/,
    );
  });

  it('supports revocation and multiple sessions per owner with lookup indexes', () => {
    expect(migration).toContain('"revoked_at" TIMESTAMP(3)');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "employee_refresh_sessions_refresh_token_hash_key"',
    );
    expect(migration).toContain(
      'CREATE INDEX "employee_refresh_sessions_employee_id_idx"',
    );
    expect(migration).toContain(
      'CREATE INDEX "employee_refresh_sessions_expires_at_idx"',
    );
    expect(migration).not.toMatch(
      /CREATE UNIQUE INDEX\s+"[^"]+"\s+ON "employee_refresh_sessions"\("employee_id"\)/,
    );
  });

  it('does not persist raw refresh tokens or speculative session metadata', () => {
    const columns = [
      ...migration.matchAll(/^\s*"([^"]+)"\s+/gm),
    ].map((match) => match[1]);

    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'employee_id',
        'refresh_token_hash',
        'issued_at',
        'expires_at',
        'revoked_at',
      ]),
    );
    expect(columns).not.toEqual(
      expect.arrayContaining([
        'refresh_token',
        'raw_token',
        'replacement_id',
        'last_used_at',
        'device_name',
      ]),
    );
  });
});
