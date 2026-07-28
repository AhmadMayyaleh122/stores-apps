import {
  createTenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning.errors';
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
    url.username = encodeURIComponent(databaseUser);
    url.password = encodeURIComponent(options.password);
    url.pathname = `/${encodeURIComponent(databaseName)}`;
    url.searchParams.set('sslmode', options.sslMode);

    return url.toString();
  } catch {
    throw createTenantProvisioningError(
      TenantProvisioningErrorCode.DATABASE_URL_INVALID,
    );
  }
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
