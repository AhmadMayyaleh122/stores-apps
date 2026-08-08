import { createTenantDatabaseIdentifiers } from './tenant-database-identifier.util';
import {
  buildTenantDatabaseUrl,
  normalizeTenantDatabaseHostname,
} from './tenant-database-url.util';

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

  it.each(['@', ':', '%', '/', ' '])(
    'round-trips PostgreSQL credentials containing %j',
    (reservedCharacter) => {
      const password = `prefix@${reservedCharacter} suffix`;
      const value = build({ password });
      const parsed = new URL(value);

      expect(parsed.protocol).toBe('postgresql:');
      expect(decodeWhatwgUrlComponent(parsed.username)).toBe(
        identifiers.databaseUser,
      );
      expect(decodeWhatwgUrlComponent(parsed.password)).toBe(password);
      expect(decodeWhatwgUrlComponent(parsed.pathname.slice(1))).toBe(
        identifiers.databaseName,
      );
      expect(parsed.searchParams.get('sslmode')).toBe('verify-full');
      expect(value).not.toContain(password);
    },
  );

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

describe('normalizeTenantDatabaseHostname', () => {
  it.each([
    ['localhost', 'loopback'],
    ['LOCALHOST.', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['127.0.0.25', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['[::1]', 'loopback'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['DB.EXAMPLE.TEST.', 'db.example.test'],
    ['192.0.2.25', '192.0.2.25'],
    ['[2001:DB8::25]', '2001:db8::25'],
  ])('normalizes %s to %s', (hostname, expected) => {
    expect(normalizeTenantDatabaseHostname(hostname)).toBe(expected);
  });

  it.each([
    ['127.attacker.example', '127.attacker.example'],
    ['127.attacker.example.', '127.attacker.example'],
    ['127.Attacker.Example', '127.attacker.example'],
    ['127.0.example', '127.0.example'],
  ])('does not classify DNS hostname %s as loopback', (hostname, expected) => {
    expect(normalizeTenantDatabaseHostname(hostname)).toBe(expected);
    expect(normalizeTenantDatabaseHostname(hostname)).not.toBe('loopback');
  });

  it('rejects an empty hostname safely', () => {
    expect(() => normalizeTenantDatabaseHostname('  ')).toThrow(
      'Tenant database URL configuration is invalid.',
    );
  });

  it.each(['[127.0.0.1]', '[db.example.test]'])(
    'rejects non-IPv6 bracketed hostname %s',
    (hostname) => {
      expect(() => normalizeTenantDatabaseHostname(hostname)).toThrow(
        'Tenant database URL configuration is invalid.',
      );
    },
  );
});

function decodeWhatwgUrlComponent(value: string): string {
  return decodeURIComponent(value.replace(/%(?![0-9a-f]{2})/gi, '%25'));
}
