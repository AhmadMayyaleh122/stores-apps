import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

import {
  createTenantProvisioningError,
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning.errors';
import {
  buildTenantDatabaseUrl,
  TENANT_DATABASE_SSL_MODES,
  TenantDatabaseSslMode,
} from '../utils/tenant-database-url.util';

const DEFAULT_POSTGRES_PORT = 5432;
const DEFAULT_TENANT_DATABASE_HOST = 'localhost';
const DEFAULT_TENANT_DATABASE_PORT = 5432;
const DEFAULT_TENANT_DATABASE_SSL_MODE: TenantDatabaseSslMode = 'disable';
const DEFAULT_TENANT_POSTGRES_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_TENANT_MIGRATION_TIMEOUT_MS = 120_000;
const SUPPORTED_ENCRYPTION_KEY_VERSION = 1;
const ENCRYPTION_KEY_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const FORBIDDEN_CONNECTION_OVERRIDE_PARAMETERS = new Set([
  'host',
  'hostaddr',
  'port',
  'user',
  'password',
  'database',
  'dbname',
  'service',
]);

interface DatabaseTarget {
  hostname: string;
  port: number;
  databaseName: string;
}

export interface TenantProvisioningConfiguration {
  readonly postgresAdminUrl: string;
  readonly tenantDatabaseHost: string;
  readonly tenantDatabasePort: number;
  readonly tenantDatabaseSslMode: TenantDatabaseSslMode;
  readonly tenantPostgresConnectionTimeoutMs: number;
  readonly tenantMigrationTimeoutMs: number;
  readonly activeEncryptionKeyVersion: number;
  readonly activeEncryptionKey: TenantProvisioningEncryptionKey;
}

export interface TenantAccessConfiguration {
  readonly tenantDatabaseHost: string;
  readonly tenantDatabasePort: number;
  readonly tenantDatabaseSslMode: TenantDatabaseSslMode;
  readonly tenantPostgresConnectionTimeoutMs: number;
  readonly encryptionKeyVersion: number;
  readonly encryptionKey: TenantProvisioningEncryptionKey;
}

export class TenantProvisioningEncryptionKey {
  readonly #keyMaterial: Buffer;

  constructor(keyMaterial: Buffer) {
    this.#keyMaterial = Buffer.from(keyMaterial);
    Object.freeze(this);
  }

  copyKeyMaterial(): Buffer {
    return Buffer.from(this.#keyMaterial);
  }
}

@Injectable()
export class TenantProvisioningConfigService {
  constructor(private readonly configService: ConfigService) {}

  getTenantAccessConfiguration(
    storedEncryptionKeyVersion: unknown,
  ): TenantAccessConfiguration {
    try {
      const connectionConfiguration = readTenantConnectionConfiguration(
        this.configService,
      );
      validateTenantConnectionConfiguration(connectionConfiguration);
      const encryptionKeyVersion = readSupportedEncryptionKeyVersion(
        storedEncryptionKeyVersion,
      );
      const encryptionKey = readEncryptionKey(
        this.configService,
        encryptionKeyVersion,
      );

      return Object.freeze({
        ...connectionConfiguration,
        encryptionKeyVersion,
        encryptionKey,
      });
    } catch (error) {
      preserveOrThrowInvalidConfiguration(error);
    }
  }

  getProvisioningConfiguration(): TenantProvisioningConfiguration {
    try {
      const postgresAdminUrl = requireNonEmptyString(
        this.configService.get<unknown>('POSTGRES_ADMIN_URL'),
      );
      const adminTarget = parseDatabaseTarget(postgresAdminUrl, true);
      const masterDatabaseUrl = readOptionalString(
        this.configService.get<unknown>('DATABASE_URL'),
      );

      if (adminTarget.databaseName.toLowerCase() === 'white_label_master') {
        throwInvalidConfiguration();
      }

      if (masterDatabaseUrl) {
        const masterTarget = parseDatabaseTarget(masterDatabaseUrl, false);

        if (targetsMatch(adminTarget, masterTarget)) {
          throwInvalidConfiguration();
        }
      }

      const connectionConfiguration = readTenantConnectionConfiguration(
        this.configService,
      );
      const tenantMigrationTimeoutMs = readPositiveIntegerWithDefault(
        this.configService.get<unknown>('TENANT_MIGRATION_TIMEOUT_MS'),
        DEFAULT_TENANT_MIGRATION_TIMEOUT_MS,
      );
      validateTenantConnectionConfiguration(connectionConfiguration);

      const activeEncryptionKeyVersion = readSupportedEncryptionKeyVersion(
        this.configService.get<unknown>(
          'TENANT_CREDENTIAL_ENCRYPTION_KEY_VERSION',
        ),
      );
      const activeEncryptionKey = readEncryptionKey(
        this.configService,
        activeEncryptionKeyVersion,
      );

      return Object.freeze({
        postgresAdminUrl,
        ...connectionConfiguration,
        tenantMigrationTimeoutMs,
        activeEncryptionKeyVersion,
        activeEncryptionKey,
      });
    } catch (error) {
      preserveOrThrowInvalidConfiguration(error);
    }
  }
}

function readTenantConnectionConfiguration(
  configService: ConfigService,
): Omit<
  TenantAccessConfiguration,
  'encryptionKeyVersion' | 'encryptionKey'
> {
  const tenantDatabaseHost = readStringWithDefault(
    configService.get<unknown>('TENANT_DATABASE_HOST'),
    DEFAULT_TENANT_DATABASE_HOST,
  );
  const tenantDatabasePort = readPositiveIntegerWithDefault(
    configService.get<unknown>('TENANT_DATABASE_PORT'),
    DEFAULT_TENANT_DATABASE_PORT,
    65535,
  );
  const tenantDatabaseSslMode = readSslMode(
    configService.get<unknown>('TENANT_DATABASE_SSL_MODE'),
  );
  const tenantPostgresConnectionTimeoutMs = readPositiveIntegerWithDefault(
    configService.get<unknown>('TENANT_POSTGRES_CONNECTION_TIMEOUT_MS'),
    DEFAULT_TENANT_POSTGRES_CONNECTION_TIMEOUT_MS,
  );
  return {
    tenantDatabaseHost,
    tenantDatabasePort,
    tenantDatabaseSslMode,
    tenantPostgresConnectionTimeoutMs,
  };
}

function validateTenantConnectionConfiguration(
  configuration: Omit<
    TenantAccessConfiguration,
    'encryptionKeyVersion' | 'encryptionKey'
  >,
): void {
  const validationCredential = randomBytes(32).toString('base64url');

  buildTenantDatabaseUrl({
    hostname: configuration.tenantDatabaseHost,
    port: configuration.tenantDatabasePort,
    databaseName: 'tenant_db_validation',
    databaseUser: 'tenant_user_validation',
    password: validationCredential,
    sslMode: configuration.tenantDatabaseSslMode,
  });
}

function readSupportedEncryptionKeyVersion(value: unknown): number {
  const encryptionKeyVersion = readRequiredPositiveInteger(value);

  if (encryptionKeyVersion !== SUPPORTED_ENCRYPTION_KEY_VERSION) {
    throwInvalidConfiguration();
  }

  return encryptionKeyVersion;
}

function readEncryptionKey(
  configService: ConfigService,
  encryptionKeyVersion: number,
): TenantProvisioningEncryptionKey {
  const encodedEncryptionKey = requireNonEmptyString(
    configService.get<unknown>(
      `TENANT_CREDENTIAL_ENCRYPTION_KEY_V${encryptionKeyVersion}`,
    ),
  );
  const encryptionKey = decodeEncryptionKey(encodedEncryptionKey);
  const controlledEncryptionKey = new TenantProvisioningEncryptionKey(
    encryptionKey,
  );
  encryptionKey.fill(0);

  return controlledEncryptionKey;
}

function parseDatabaseTarget(value: string, requireUsername: boolean): DatabaseTarget {
  const url = new URL(value);

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throwInvalidConfiguration();
  }

  rejectConnectionTargetOverrides(url);

  const hostname = normalizeHostname(url.hostname);
  const port = url.port ? Number(url.port) : DEFAULT_POSTGRES_PORT;
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const username = decodeURIComponent(url.username);

  if (
    !hostname ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    databaseName.trim().length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(databaseName) ||
    (requireUsername &&
      (username.trim().length === 0 || CONTROL_CHARACTER_PATTERN.test(username)))
  ) {
    throwInvalidConfiguration();
  }

  return {
    hostname,
    port,
    databaseName,
  };
}

function rejectConnectionTargetOverrides(url: URL): void {
  for (const parameterName of url.searchParams.keys()) {
    if (
      FORBIDDEN_CONNECTION_OVERRIDE_PARAMETERS.has(parameterName.toLowerCase())
    ) {
      throwInvalidConfiguration();
    }
  }
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');

  if (
    normalized === 'localhost' ||
    normalized.startsWith('127.') ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1'
  ) {
    return 'loopback';
  }

  return normalized;
}

function targetsMatch(left: DatabaseTarget, right: DatabaseTarget): boolean {
  return (
    left.hostname === right.hostname &&
    left.port === right.port &&
    left.databaseName === right.databaseName
  );
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throwInvalidConfiguration();
  }

  const normalized = value.trim();

  return normalized || undefined;
}

function requireNonEmptyString(value: unknown): string {
  const normalized = readOptionalString(value);

  if (!normalized) {
    throwInvalidConfiguration();
  }

  return normalized;
}

function readStringWithDefault(value: unknown, defaultValue: string): string {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  return requireNonEmptyString(value);
}

function readSslMode(value: unknown): TenantDatabaseSslMode {
  const sslMode = readStringWithDefault(
    value,
    DEFAULT_TENANT_DATABASE_SSL_MODE,
  );

  if (!TENANT_DATABASE_SSL_MODES.includes(sslMode as TenantDatabaseSslMode)) {
    throwInvalidConfiguration();
  }

  return sslMode as TenantDatabaseSslMode;
}

function readPositiveIntegerWithDefault(
  value: unknown,
  defaultValue: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const parsed = parsePositiveInteger(value);

  if (parsed > maximum) {
    throwInvalidConfiguration();
  }

  return parsed;
}

function readRequiredPositiveInteger(value: unknown): number {
  if (value === undefined || value === null) {
    throwInvalidConfiguration();
  }

  return parsePositiveInteger(value);
}

function parsePositiveInteger(value: unknown): number {
  const normalized = typeof value === 'number' ? String(value) : value;

  if (
    typeof normalized !== 'string' ||
    !/^[1-9]\d*$/.test(normalized)
  ) {
    throwInvalidConfiguration();
  }

  const parsed = Number(normalized);

  if (!Number.isSafeInteger(parsed)) {
    throwInvalidConfiguration();
  }

  return parsed;
}

function decodeEncryptionKey(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throwInvalidConfiguration();
  }

  const decoded = Buffer.from(value, 'base64url');

  if (
    decoded.length !== ENCRYPTION_KEY_BYTES ||
    decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    throwInvalidConfiguration();
  }

  return decoded;
}

function preserveOrThrowInvalidConfiguration(error: unknown): never {
  if (
    error instanceof TenantProvisioningError &&
    error.code === TenantProvisioningErrorCode.CONFIGURATION_INVALID
  ) {
    throw error;
  }

  throwInvalidConfiguration();
}

function throwInvalidConfiguration(): never {
  throw createTenantProvisioningError(
    TenantProvisioningErrorCode.CONFIGURATION_INVALID,
  );
}
