import {
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning.errors';

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const POSTGRES_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
export const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

export interface TenantDatabaseIdentifiers {
  databaseName: string;
  databaseUser: string;
}

export function normalizeCanonicalUuid(value: string): string {
  if (typeof value !== 'string' || !CANONICAL_UUID_PATTERN.test(value)) {
    throwInvalidIdentifier();
  }

  return value.toLowerCase();
}

export function createTenantDatabaseIdentifiers(
  storeId: string,
): TenantDatabaseIdentifiers {
  const uuidHex = normalizeCanonicalUuid(storeId).replaceAll('-', '');
  const databaseName = `tenant_db_${uuidHex}`;
  const databaseUser = `tenant_user_${uuidHex}`;

  validatePostgresIdentifier(databaseName);
  validatePostgresIdentifier(databaseUser);

  return {
    databaseName,
    databaseUser,
  };
}

export function validatePostgresIdentifier(identifier: string): string {
  if (
    typeof identifier !== 'string' ||
    !POSTGRES_IDENTIFIER_PATTERN.test(identifier) ||
    Buffer.byteLength(identifier, 'ascii') > POSTGRES_IDENTIFIER_MAX_BYTES
  ) {
    throwInvalidIdentifier();
  }

  return identifier;
}

export function quotePostgresIdentifier(identifier: string): string {
  const validatedIdentifier = validatePostgresIdentifier(identifier);
  const escapedIdentifier = validatedIdentifier.replaceAll('"', '""');

  return `"${escapedIdentifier}"`;
}

function throwInvalidIdentifier(): never {
  throw new TenantProvisioningError(
    TenantProvisioningErrorCode.IDENTIFIER_INVALID,
    'Tenant database identifier is invalid.',
  );
}
