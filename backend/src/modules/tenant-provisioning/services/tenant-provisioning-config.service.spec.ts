import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import * as tenantDatabaseUrlUtils from '../utils/tenant-database-url.util';
import { TenantProvisioningConfigService } from './tenant-provisioning-config.service';

describe('TenantProvisioningConfigService', () => {
  const encodedKey = Buffer.alloc(32, 11).toString('base64url');
  const validValues: Record<string, unknown> = {
    POSTGRES_ADMIN_URL:
      'postgresql://provisioner:test-only@localhost:5432/postgres?sslmode=disable',
    DATABASE_URL:
      'postgresql://master:test-only@localhost:5432/white_label_master',
    TENANT_DATABASE_HOST: 'localhost',
    TENANT_DATABASE_PORT: '5432',
    TENANT_DATABASE_SSL_MODE: 'disable',
    TENANT_POSTGRES_CONNECTION_TIMEOUT_MS: '10000',
    TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION: '1',
    TENANT_CREDENTIAL_ENCRYPTION_KEY_V1: encodedKey,
    TENANT_MIGRATION_TIMEOUT_MS: '120000',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createService(overrides: Record<string, unknown> = {}): {
    service: TenantProvisioningConfigService;
    get: jest.Mock;
  } {
    const values = { ...validValues, ...overrides };
    const get = jest.fn((key: string) => values[key]);

    return {
      service: new TenantProvisioningConfigService({
        get,
      } as unknown as ConfigService),
      get,
    };
  }

  it('does not read provisioning configuration during construction', () => {
    const { get } = createService();

    expect(get).not.toHaveBeenCalled();
  });

  it('resolves tenant access configuration without the PostgreSQL admin URL', () => {
    const { service, get } = createService({ POSTGRES_ADMIN_URL: undefined });
    const configuration = service.getTenantAccessConfiguration(1);

    expect(configuration).toMatchObject({
      tenantDatabaseHost: 'localhost',
      tenantDatabasePort: 5432,
      tenantDatabaseSslMode: 'disable',
      tenantPostgresConnectionTimeoutMs: 10000,
      encryptionKeyVersion: 1,
    });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(configuration.encryptionKey.copyKeyMaterial()).toEqual(
      Buffer.alloc(32, 11),
    );
    expect(get).not.toHaveBeenCalledWith('POSTGRES_ADMIN_URL');
    expect(get).not.toHaveBeenCalledWith('DATABASE_URL');
    expect(get).not.toHaveBeenCalledWith('TENANT_MIGRATION_TIMEOUT_MS');
    expect(get).not.toHaveBeenCalledWith(
      'TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION',
    );
  });

  it.each([undefined, null, 0, 2, '1.5']) (
    'rejects unsupported stored tenant credential key version %p safely',
    (keyVersion) => {
      const { service } = createService();

      expect(() => service.getTenantAccessConfiguration(keyVersion)).toThrow(
        'Tenant provisioning configuration is invalid.',
      );
    },
  );

  it('rejects a missing stored-version encryption key safely', () => {
    const { service } = createService({
      TENANT_CREDENTIAL_ENCRYPTION_KEY_V1: undefined,
    });

    expect(() => service.getTenantAccessConfiguration(1)).toThrow(
      'Tenant provisioning configuration is invalid.',
    );
  });

  it('rejects a missing PostgreSQL admin URL', () => {
    const { service } = createService({ POSTGRES_ADMIN_URL: undefined });

    expect(() => service.getProvisioningConfiguration()).toThrow(
      'Tenant provisioning configuration is invalid.',
    );
  });

  it('rejects an unsupported PostgreSQL admin protocol', () => {
    const { service } = createService({
      POSTGRES_ADMIN_URL: 'mysql://provisioner:test-only@localhost/postgres',
    });

    expect(() => service.getProvisioningConfiguration()).toThrow();
  });

  it.each([
    'postgresql://localhost:5432/postgres',
    'postgresql://provisioner@:5432/postgres',
    'postgresql://provisioner@localhost:5432/',
  ])('rejects missing admin URL components', (postgresAdminUrl) => {
    const { service } = createService({
      POSTGRES_ADMIN_URL: postgresAdminUrl,
    });

    expect(() => service.getProvisioningConfiguration()).toThrow(
      'Tenant provisioning configuration is invalid.',
    );
  });

  it('rejects white_label_master as the maintenance database', () => {
    const { service } = createService({
      POSTGRES_ADMIN_URL:
        'postgresql://provisioner:test-only@db.example.test/white_label_master',
      DATABASE_URL: undefined,
    });

    expect(() => service.getProvisioningConfiguration()).toThrow();
  });

  it('rejects an exact normal host, port, and database collision', () => {
    const { service } = createService({
      POSTGRES_ADMIN_URL:
        'postgresql://provisioner:test-only@DB.EXAMPLE.TEST:5440/platform_master',
      DATABASE_URL:
        'postgres://master:test-only@db.example.test:5440/platform_master?schema=public',
    });

    expect(() => service.getProvisioningConfiguration()).toThrow();
  });

  it.each([
    'host=localhost',
    'hostaddr=127.0.0.1',
    'port=5432',
    'user=other-user',
    'password=do-not-expose',
    'database=postgres',
    'dbname=postgres',
    'service=example',
    'HOST=localhost',
    'HostAddr=127.0.0.1',
  ])('rejects PostgreSQL admin URL target override %s', (parameter) => {
    const { service } = createService({
      POSTGRES_ADMIN_URL: `${validValues.POSTGRES_ADMIN_URL}&${parameter}`,
    });

    expect(() => service.getProvisioningConfiguration()).toThrow(
      'Tenant provisioning configuration is invalid.',
    );
  });

  it.each([
    'host=localhost',
    'hostaddr=127.0.0.1',
    'port=5432',
    'user=other-user',
    'password=do-not-expose',
    'database=white_label_master',
    'dbname=white_label_master',
    'service=example',
    'HOST=localhost',
    'HostAddr=127.0.0.1',
  ])('rejects master database URL target override %s', (parameter) => {
    const { service } = createService({
      DATABASE_URL: `postgresql://master:test-only@localhost:5432/white_label_master?${parameter}`,
    });

    expect(() => service.getProvisioningConfiguration()).toThrow(
      'Tenant provisioning configuration is invalid.',
    );
  });

  it.each([
    'host=first.example.test&host=second.example.test',
    'port=5432&PORT=5440',
  ])('rejects duplicate target override parameters %s', (parameters) => {
    const { service } = createService({
      POSTGRES_ADMIN_URL: `postgresql://provisioner:test-only@localhost:5432/postgres?${parameters}`,
    });

    expect(() => service.getProvisioningConfiguration()).toThrow(
      'Tenant provisioning configuration is invalid.',
    );
  });

  it('allows non-target PostgreSQL connection parameters', () => {
    const { service } = createService({
      POSTGRES_ADMIN_URL:
        'postgresql://provisioner:test-only@localhost:5432/postgres?sslmode=verify-full&application_name=provisioner',
    });

    expect(service.getProvisioningConfiguration().postgresAdminUrl).toContain(
      'sslmode=verify-full',
    );
  });

  it.each([
    'postgresql://%20:test-only@localhost:5432/postgres',
    'postgresql://%09:test-only@localhost:5432/postgres',
    'postgresql://provisioner:test-only@localhost:5432/%20',
    'postgresql://provisioner:test-only@localhost:5432/%0A',
  ])('rejects whitespace-only or control-character URL components', (url) => {
    const { service } = createService({ POSTGRES_ADMIN_URL: url });

    expect(() => service.getProvisioningConfiguration()).toThrow(
      'Tenant provisioning configuration is invalid.',
    );
  });

  it.each([
    ['localhost', '127.0.0.1'],
    ['localhost', '127.0.0.25'],
    ['localhost', '[::1]'],
    ['[::1]', '[0:0:0:0:0:0:0:1]'],
  ])('rejects normalized loopback collision %s versus %s', (adminHost, masterHost) => {
    const { service } = createService({
      POSTGRES_ADMIN_URL: `postgresql://provisioner:test-only@${adminHost}:5432/postgres`,
      DATABASE_URL: `postgresql://master:test-only@${masterHost}:5432/postgres`,
    });

    expect(() => service.getProvisioningConfiguration()).toThrow();
  });

  it('accepts a valid separate maintenance database', () => {
    const { service } = createService();

    expect(service.getProvisioningConfiguration().postgresAdminUrl).toBe(
      validValues.POSTGRES_ADMIN_URL,
    );
  });

  it('uses a generated validation credential without exposing or logging it', () => {
    const urlBuilder = jest.spyOn(
      tenantDatabaseUrlUtils,
      'buildTenantDatabaseUrl',
    );
    const logSpies = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(),
      jest.spyOn(console, 'log').mockImplementation(),
      jest.spyOn(console, 'error').mockImplementation(),
      jest.spyOn(console, 'warn').mockImplementation(),
      jest.spyOn(console, 'debug').mockImplementation(),
    ];
    const { service } = createService();

    const configuration = service.getProvisioningConfiguration();
    const validationCredential = urlBuilder.mock.calls[0][0].password;

    expect(urlBuilder).toHaveBeenCalledTimes(1);
    expect(validationCredential).toEqual(expect.any(String));
    expect(validationCredential).not.toHaveLength(0);
    expect(validationCredential).not.toBe('configuration-validation-only');
    expect(JSON.stringify(configuration)).not.toContain(validationCredential);
    for (const spy of logSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it.each([
    { POSTGRES_ADMIN_URL: 'postgresql://provisioner@localhost:0/postgres' },
    { TENANT_DATABASE_PORT: '0' },
    { TENANT_DATABASE_PORT: '65536' },
  ])('rejects invalid effective ports', (overrides) => {
    const { service } = createService(overrides);

    expect(() => service.getProvisioningConfiguration()).toThrow();
  });

  it('rejects an invalid tenant database host', () => {
    const { service } = createService({ TENANT_DATABASE_HOST: '' });

    expect(() => service.getProvisioningConfiguration()).toThrow();
  });

  it('rejects an invalid tenant SSL mode', () => {
    const { service } = createService({
      TENANT_DATABASE_SSL_MODE: 'prefer',
    });

    expect(() => service.getProvisioningConfiguration()).toThrow();
  });

  it.each([
    { TENANT_POSTGRES_CONNECTION_TIMEOUT_MS: '0' },
    { TENANT_POSTGRES_CONNECTION_TIMEOUT_MS: '1.5' },
    { TENANT_MIGRATION_TIMEOUT_MS: '-1' },
    { TENANT_MIGRATION_TIMEOUT_MS: 'not-a-number' },
  ])('rejects invalid timeout configuration', (overrides) => {
    const { service } = createService(overrides);

    expect(() => service.getProvisioningConfiguration()).toThrow();
  });

  it.each([
    { TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION: undefined },
    { TENANT_CREDENTIAL_ENCRYPTION_KEY_V1: undefined },
    { TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION: '0' },
    { TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION: '2' },
    { TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION: '1.5' },
  ])('rejects missing or unsupported encryption configuration', (overrides) => {
    const { service } = createService(overrides);

    expect(() => service.getProvisioningConfiguration()).toThrow();
  });

  it.each([
    'not+base64url',
    `${encodedKey}=`,
    Buffer.alloc(31, 11).toString('base64url'),
    Buffer.alloc(33, 11).toString('base64url'),
  ])('rejects malformed or incorrectly sized key material', (key) => {
    const { service } = createService({
      TENANT_CREDENTIAL_ENCRYPTION_KEY_V1: key,
    });

    expect(() => service.getProvisioningConfiguration()).toThrow();
  });

  it('applies non-secret defaults when optional values are absent', () => {
    const { service } = createService({
      TENANT_DATABASE_HOST: undefined,
      TENANT_DATABASE_PORT: undefined,
      TENANT_DATABASE_SSL_MODE: undefined,
      TENANT_POSTGRES_CONNECTION_TIMEOUT_MS: undefined,
      TENANT_MIGRATION_TIMEOUT_MS: undefined,
    });

    expect(service.getProvisioningConfiguration()).toMatchObject({
      tenantDatabaseHost: 'localhost',
      tenantDatabasePort: 5432,
      tenantDatabaseSslMode: 'disable',
      tenantPostgresConnectionTimeoutMs: 10000,
      tenantMigrationTimeoutMs: 120000,
    });
  });

  it('returns a complete immutable validated configuration', () => {
    const { service } = createService();
    const configuration = service.getProvisioningConfiguration();

    expect(Object.isFrozen(configuration)).toBe(true);
    expect(configuration).toMatchObject({
      postgresAdminUrl: validValues.POSTGRES_ADMIN_URL,
      tenantDatabaseHost: 'localhost',
      tenantDatabasePort: 5432,
      tenantDatabaseSslMode: 'disable',
      tenantPostgresConnectionTimeoutMs: 10000,
      tenantMigrationTimeoutMs: 120000,
      activeEncryptionKeyVersion: 1,
    });
    const firstKeyCopy = configuration.activeEncryptionKey.copyKeyMaterial();

    expect(firstKeyCopy).toEqual(Buffer.alloc(32, 11));
    firstKeyCopy.fill(0);
    expect(configuration.activeEncryptionKey.copyKeyMaterial()).toEqual(
      Buffer.alloc(32, 11),
    );
  });

  it('uses safe errors without URL, password, or encryption key values', () => {
    const adminUrl =
      'postgresql://provisioner:do-not-expose@localhost:5432/white_label_master';
    const { service } = createService({ POSTGRES_ADMIN_URL: adminUrl });

    try {
      service.getProvisioningConfiguration();
      throw new Error('Expected configuration validation to fail');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).not.toContain(adminUrl);
      expect(message).not.toContain('do-not-expose');
      expect(message).not.toContain(encodedKey);
    }
  });

  it('does not expose rejected target override values', () => {
    const adminUrl =
      'postgresql://provisioner:admin-password@safe.example.test/postgres?host=unexpected-host.example&password=query-password';
    const { service } = createService({ POSTGRES_ADMIN_URL: adminUrl });

    try {
      service.getProvisioningConfiguration();
      throw new Error('Expected configuration validation to fail');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).not.toContain(adminUrl);
      expect(message).not.toContain('admin-password');
      expect(message).not.toContain('query-password');
      expect(message).not.toContain('safe.example.test');
      expect(message).not.toContain('unexpected-host.example');
    }
  });
});
