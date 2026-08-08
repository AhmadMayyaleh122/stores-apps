import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

const tenantPrismaRoot = path.resolve(
  __dirname,
  '../../../../prisma/tenant',
);
const migrationName =
  '20260808192202_store_owner_activation_credentials';

describe('tenant Store Owner activation credential schema', () => {
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

  it('defines separate EmployeeCredential and EmployeeActivationToken models', () => {
    expect(schema).toMatch(
      /model EmployeeCredential\s*{[\s\S]*?@@map\("employee_credentials"\)\s*}/,
    );
    expect(schema).toMatch(
      /model EmployeeActivationToken\s*{[\s\S]*?@@map\("employee_activation_tokens"\)\s*}/,
    );
    expect(schema).toMatch(/credential\s+EmployeeCredential\?/);
    expect(schema).toMatch(/activationTokens\s+EmployeeActivationToken\[\]/);
    expect(migration).toContain('CREATE TABLE "employee_credentials"');
    expect(migration).toContain(
      'CREATE TABLE "employee_activation_tokens"',
    );
  });

  it('uses the required opaque credential and token database types', () => {
    expect(schema).toMatch(
      /passwordHash\s+String\s+@map\("password_hash"\)\s+@db\.VarChar\(255\)/,
    );
    expect(schema).toMatch(
      /tokenHash\s+Bytes\s+@unique\(map: "employee_activation_tokens_token_hash_key"\)\s+@map\("token_hash"\)\s+@db\.ByteA/,
    );
    expect(migration).toContain('"password_hash" VARCHAR(255) NOT NULL');
    expect(migration).toContain('"token_hash" BYTEA NOT NULL');
  });

  it('enforces the credential shared primary key and cascading Employee foreign keys', () => {
    expect(schema).toMatch(
      /employeeId\s+String\s+@id\(map: "employee_credentials_pkey"\)\s+@map\("employee_id"\)\s+@db\.Uuid/,
    );
    expect(migration).toContain(
      'CONSTRAINT "employee_credentials_pkey" PRIMARY KEY ("employee_id")',
    );
    expect(migration).toContain(
      'CONSTRAINT "employee_credentials_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
    expect(migration).toContain(
      'CONSTRAINT "employee_activation_tokens_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
  });

  it('creates token uniqueness and lookup indexes', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "employee_activation_tokens_token_hash_key" ON "employee_activation_tokens"("token_hash");',
    );
    expect(migration).toContain(
      'CREATE INDEX "employee_activation_tokens_employee_id_idx" ON "employee_activation_tokens"("employee_id");',
    );
    expect(migration).toContain(
      'CREATE INDEX "employee_activation_tokens_expires_at_idx" ON "employee_activation_tokens"("expires_at");',
    );
  });

  it('allows at most one outstanding token without using wall-clock time', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "employee_activation_tokens_one_outstanding_per_employee_key"\s+ON "employee_activation_tokens" \("employee_id"\)\s+WHERE "consumed_at" IS NULL\s+AND "revoked_at" IS NULL;/,
    );
    expect(migration).not.toMatch(
      /CREATE UNIQUE INDEX[\s\S]*?WHERE[\s\S]*?(?:current_timestamp|now\s*\()/i,
    );
  });

  it('adds the credential and activation-token integrity checks', () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT "employee_credentials_password_hash_nonempty_check"\s+CHECK \(length\("password_hash"\) > 0\);/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT "employee_activation_tokens_token_hash_length_check"\s+CHECK \(octet_length\("token_hash"\) = 32\);/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT "employee_activation_tokens_expiry_order_check"\s+CHECK \("expires_at" > "created_at"\);/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT "employee_activation_tokens_terminal_state_check"\s+CHECK \(NOT \("consumed_at" IS NOT NULL AND "revoked_at" IS NOT NULL\)\);/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT "employee_activation_tokens_consumed_at_check"\s+CHECK \("consumed_at" IS NULL OR "consumed_at" >= "created_at"\);/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT "employee_activation_tokens_revoked_at_check"\s+CHECK \("revoked_at" IS NULL OR "revoked_at" >= "created_at"\);/,
    );
  });

  it('keeps authentication secrets off the Employee table and stores no raw token material', () => {
    const employeeModel = schema.match(/model Employee\s*{([\s\S]*?)\n}/);
    const newTableColumns = extractCreatedColumnNames(migration);

    expect(employeeModel).not.toBeNull();
    expect(employeeModel?.[1]).not.toMatch(
      /^\s*(?:password|passwordHash|token|tokenHash|activationToken|activationUrl|tokenPlaintext|refreshToken|jwt|passwordResetToken)\s+/m,
    );
    expect(migration).not.toContain('ALTER TABLE "employees" ADD COLUMN');
    expect(newTableColumns).not.toEqual(
      expect.arrayContaining([
        'password',
        'plaintext_password',
        'raw_activation_token',
        'activation_url',
        'token',
        'token_plaintext',
        'refresh_token',
        'jwt',
        'password_reset_token',
      ]),
    );
  });
});

function extractCreatedColumnNames(migration: string): string[] {
  return [...migration.matchAll(/CREATE TABLE "[^"]+" \(([\s\S]*?)\n\);/g)]
    .flatMap((match) => [...match[1].matchAll(/^\s*"([^"]+)"/gm)])
    .map((match) => match[1]);
}
