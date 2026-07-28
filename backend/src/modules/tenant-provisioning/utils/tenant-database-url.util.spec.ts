import { createTenantDatabaseIdentifiers } from './tenant-database-identifier.util';
import { buildTenantDatabaseUrl } from './tenant-database-url.util';

describe('buildTenantDatabaseUrl', () => {
  const identifiers = createTenantDatabaseIdentifiers(
    '12345678-1234-4234-8123-456789012345',
  );

  function build(
    overrides: Partial<Parameters<typeof buildTenantDatabaseUrl>[0]> = {},
  ): string {
    return buildTenantDatabaseUrl({
      hostname: 'db.example.test',
      port: 5432,
      ...identifiers,
      password: 'secret-password',
      sslMode: 'verify-full',
      ...overrides,
    });
  }

  it('builds a PostgreSQL URL with encoded credentials and database name', () => {
    const password = 'p@ss:/?#% word[]';
    const value = build({ password });
    const parsed = new URL(value);

    expect(parsed.protocol).toBe('postgresql:');
    expect(decodeURIComponent(parsed.username)).toBe(identifiers.databaseUser);
    expect(decodeURIComponent(parsed.password)).toBe(password);
    expect(decodeURIComponent(parsed.pathname)).toBe(
      `/${identifiers.databaseName}`,
    );
    expect(parsed.searchParams.get('sslmode')).toBe('verify-full');
    expect(value).not.toContain(password);
  });

  it.each([
    ['DNS', 'db.example.test'],
    ['IPv4', '192.0.2.25'],
    ['IPv6', '2001:db8::25'],
    ['bracketed IPv6', '[2001:db8::25]'],
  ])('supports %s hostnames', (_label, hostname) => {
    const parsed = new URL(build({ hostname }));

    expect(parsed.hostname).toBe(
      hostname.includes(':')
        ? `[${hostname.replace(/^\[|\]$/g, '')}]`
        : hostname,
    );
  });

  it.each(['disable', 'require', 'verify-ca', 'verify-full'] as const)(
    'supports the %s SSL mode',
    (sslMode) => {
      expect(new URL(build({ sslMode })).searchParams.get('sslmode')).toBe(
        sslMode,
      );
    },
  );

  it.each([0, 65536, 1.5, Number.NaN])(
    'rejects invalid port %s',
    (port) => {
      expect(() => build({ port })).toThrow(
        'Tenant database URL configuration is invalid.',
      );
    },
  );

  it('rejects an empty host', () => {
    expect(() => build({ hostname: '  ' })).toThrow(
      'Tenant database URL configuration is invalid.',
    );
  });

  it.each([
    { databaseName: 'tenant-db' },
    { databaseUser: 'tenant user' },
  ])('rejects an invalid internal identifier', (overrides) => {
    expect(() => build(overrides)).toThrow(
      'Tenant database URL configuration is invalid.',
    );
  });

  it('does not include a password in an error', () => {
    const password = 'do-not-expose-this-password';

    try {
      build({ password, port: 0 });
      throw new Error('Expected URL construction to fail');
    } catch (error) {
      expect((error as Error).message).not.toContain(password);
    }
  });
});
