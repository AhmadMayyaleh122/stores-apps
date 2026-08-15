import {
  createTenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning.errors';
import { isIP } from 'node:net';
import { validatePostgresIdentifier } from './tenant-database-identifier.util';

export const TENANT_DATABASE_SSL_MODES = [
  'disable',
  'require',
  'verify-ca',
  'verify-full',
] as const;

export type TenantDatabaseSslMode =
  (typeof TENANT_DATABASE_SSL_MODES)[number];

export interface TenantDatabaseUrlOptions {
  hostname: string;
  port: number;
  databaseName: string;
  databaseUser: string;
  password: string;
  sslMode: TenantDatabaseSslMode;
}

export function buildTenantDatabaseUrl(
  options: TenantDatabaseUrlOptions,
): string {
  try {
    const hostname = parseHostname(options.hostname);

    if (
      !Number.isInteger(options.port) ||
      options.port < 1 ||
      options.port > 65535
    ) {
      throw new Error('Invalid port');
    }

    const databaseName = validatePostgresIdentifier(options.databaseName);
    const databaseUser = validatePostgresIdentifier(options.databaseUser);

    if (typeof options.password !== 'string' || options.password.length === 0) {
      throw new Error('Invalid password');
    }

    if (!TENANT_DATABASE_SSL_MODES.includes(options.sslMode)) {
      throw new Error('Invalid SSL mode');
    }

    const url = new URL('postgresql://placeholder');
    url.hostname = hostname;
    url.port = String(options.port);
    url.username = databaseUser;
    url.password = options.password;
    url.pathname = `/${databaseName}`;
    url.searchParams.set('sslmode', options.sslMode);

    return url.toString();
  } catch {
    throw createTenantProvisioningError(
      TenantProvisioningErrorCode.DATABASE_URL_INVALID,
    );
  }
}

export function normalizeTenantDatabaseHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();

  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    const unbracketedHostname = normalized.slice(1, -1);

    if (isIP(unbracketedHostname) !== 6) {
      throw createTenantProvisioningError(
        TenantProvisioningErrorCode.DATABASE_URL_INVALID,
      );
    }

    normalized = unbracketedHostname;
  }

  if (!normalized.includes(':') && normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }

  if (!normalized) {
    throw createTenantProvisioningError(
      TenantProvisioningErrorCode.DATABASE_URL_INVALID,
    );
  }

  const ipVersion = isIP(normalized);

  if (
    normalized === 'localhost' ||
    (ipVersion === 4 && Number(normalized.split('.')[0]) === 127) ||
    (ipVersion === 6 &&
      (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1'))
  ) {
    return 'loopback';
  }

  return normalized;
}

function parseHostname(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Invalid hostname');
  }

  const hostname = value.trim();
  const authority =
    hostname.includes(':') && !hostname.startsWith('[')
      ? `[${hostname}]`
      : hostname;
  const parsed = new URL(`postgresql://${authority}`);

  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== '/')
  ) {
    throw new Error('Invalid hostname');
  }

  return parsed.hostname;
}
