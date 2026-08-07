import {
  createTenantDatabaseIdentifiers,
  POSTGRES_IDENTIFIER_MAX_BYTES,
  POSTGRES_IDENTIFIER_PATTERN,
  quotePostgresIdentifier,
  validatePostgresIdentifier,
} from './tenant-database-identifier.util';

describe('tenant database identifier utilities', () => {
  const storeId = '12345678-1234-4234-8123-456789012345';

  it('creates the exact deterministic database and user identifiers', () => {
    expect(createTenantDatabaseIdentifiers(storeId)).toEqual({
      databaseName: 'tenant_db_12345678123442348123456789012345',
      databaseUser: 'tenant_user_12345678123442348123456789012345',
    });
  });

  it('normalizes uppercase UUID hex to lowercase', () => {
    expect(
      createTenantDatabaseIdentifiers(
        'A987FBC9-4BED-4078-8F07-9141BA07C9F3',
      ),
    ).toEqual({
      databaseName: 'tenant_db_a987fbc94bed40788f079141ba07c9f3',
      databaseUser: 'tenant_user_a987fbc94bed40788f079141ba07c9f3',
    });
  });

  it.each([
    '',
    'not-a-uuid',
    '12345678123442348123456789012345',
    '12345678-1234-4234-7123-456789012345',
    '12345678-1234-0234-8123-456789012345',
  ])('rejects a non-canonical Store UUID: %s', (invalidStoreId) => {
    expect(() => createTenantDatabaseIdentifiers(invalidStoreId)).toThrow(
      'Tenant database identifier is invalid.',
    );
  });

  it('produces identifiers that match the PostgreSQL grammar', () => {
    const identifiers = createTenantDatabaseIdentifiers(storeId);

    expect(identifiers.databaseName).toMatch(POSTGRES_IDENTIFIER_PATTERN);
    expect(identifiers.databaseUser).toMatch(POSTGRES_IDENTIFIER_PATTERN);
  });

  it('keeps identifiers within the PostgreSQL 63-byte limit', () => {
    const identifiers = createTenantDatabaseIdentifiers(storeId);

    expect(Buffer.byteLength(identifiers.databaseName, 'ascii')).toBeLessThanOrEqual(
      POSTGRES_IDENTIFIER_MAX_BYTES,
    );
    expect(Buffer.byteLength(identifiers.databaseUser, 'ascii')).toBeLessThanOrEqual(
      POSTGRES_IDENTIFIER_MAX_BYTES,
    );
    expect(() => validatePostgresIdentifier(`a${'b'.repeat(63)}`)).toThrow();
  });

  it('is stable for repeated calls with the same Store UUID', () => {
    expect(createTenantDatabaseIdentifiers(storeId)).toEqual(
      createTenantDatabaseIdentifiers(storeId),
    );
  });

  it('strictly validates and quotes an internal identifier', () => {
    const { databaseName } = createTenantDatabaseIdentifiers(storeId);

    expect(quotePostgresIdentifier(databaseName)).toBe(`"${databaseName}"`);
  });

  it.each([
    'tenant database',
    'tenant;database',
    'tenant"database',
    'tenant-database',
    'tenant_database; DROP DATABASE postgres',
    'SELECT * FROM tenants',
  ])('rejects unsafe PostgreSQL identifier input: %s', (identifier) => {
    expect(() => quotePostgresIdentifier(identifier)).toThrow(
      'Tenant database identifier is invalid.',
    );
  });
});
