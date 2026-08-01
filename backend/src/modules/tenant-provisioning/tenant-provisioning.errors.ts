export enum TenantProvisioningErrorCode {
  IDENTIFIER_INVALID = 'TENANT_IDENTIFIER_INVALID',
  DATABASE_URL_INVALID = 'TENANT_DATABASE_URL_INVALID',
  CONFIGURATION_INVALID = 'TENANT_PROVISIONING_CONFIGURATION_INVALID',
  ENCRYPTION_KEY_INVALID = 'TENANT_ENCRYPTION_KEY_INVALID',
  CREDENTIAL_ENCRYPTION_FAILED = 'TENANT_CREDENTIAL_ENCRYPTION_FAILED',
  CREDENTIAL_DECRYPTION_FAILED = 'TENANT_CREDENTIAL_DECRYPTION_FAILED',
  POSTGRES_ADMIN_UNAVAILABLE = 'POSTGRES_ADMIN_UNAVAILABLE',
  ROLE_CONFLICT = 'TENANT_ROLE_CONFLICT',
  ROLE_PROVISIONING_FAILED = 'TENANT_ROLE_PROVISIONING_FAILED',
  DATABASE_OWNER_CONFLICT = 'TENANT_DATABASE_OWNER_CONFLICT',
  DATABASE_PROVISIONING_FAILED = 'TENANT_DATABASE_PROVISIONING_FAILED',
  MIGRATION_FAILED = 'TENANT_MIGRATION_FAILED',
  IDENTITY_MISMATCH = 'TENANT_IDENTITY_MISMATCH',
  IDENTITY_INITIALIZATION_FAILED = 'TENANT_IDENTITY_INITIALIZATION_FAILED',
  VERIFICATION_FAILED = 'TENANT_VERIFICATION_FAILED',
  IDENTITY_CLEANUP_FAILED = 'TENANT_IDENTITY_CLEANUP_FAILED',
  STORE_NOT_FOUND = 'TENANT_STORE_NOT_FOUND',
  PROVISIONING_NOT_FOUND = 'TENANT_PROVISIONING_NOT_FOUND',
  IDENTIFIER_CONFLICT = 'TENANT_IDENTIFIER_CONFLICT',
  RECORD_INTEGRITY_FAILED = 'TENANT_RECORD_INTEGRITY_FAILED',
  CONFIGURATION_DRIFT = 'TENANT_CONFIGURATION_DRIFT',
  PROVISIONING_IN_PROGRESS = 'TENANT_PROVISIONING_IN_PROGRESS',
  PROVISIONING_STATE_CONFLICT = 'TENANT_PROVISIONING_STATE_CONFLICT',
  PROVISIONING_FAILED = 'TENANT_PROVISIONING_FAILED',
}

export const TENANT_PROVISIONING_SAFE_MESSAGES = {
  [TenantProvisioningErrorCode.IDENTIFIER_INVALID]:
    'Tenant database identifier is invalid.',
  [TenantProvisioningErrorCode.DATABASE_URL_INVALID]:
    'Tenant database URL configuration is invalid.',
  [TenantProvisioningErrorCode.CONFIGURATION_INVALID]:
    'Tenant provisioning configuration is invalid.',
  [TenantProvisioningErrorCode.ENCRYPTION_KEY_INVALID]:
    'Tenant credential encryption key is invalid.',
  [TenantProvisioningErrorCode.CREDENTIAL_ENCRYPTION_FAILED]:
    'Tenant credential could not be encrypted.',
  [TenantProvisioningErrorCode.CREDENTIAL_DECRYPTION_FAILED]:
    'Tenant credential could not be decrypted.',
  [TenantProvisioningErrorCode.POSTGRES_ADMIN_UNAVAILABLE]:
    'PostgreSQL administration is unavailable.',
  [TenantProvisioningErrorCode.ROLE_CONFLICT]:
    'Tenant PostgreSQL role conflicts with expected ownership.',
  [TenantProvisioningErrorCode.ROLE_PROVISIONING_FAILED]:
    'Tenant PostgreSQL role could not be provisioned.',
  [TenantProvisioningErrorCode.DATABASE_OWNER_CONFLICT]:
    'Tenant database conflicts with expected ownership.',
  [TenantProvisioningErrorCode.DATABASE_PROVISIONING_FAILED]:
    'Tenant database could not be provisioned.',
  [TenantProvisioningErrorCode.MIGRATION_FAILED]:
    'Tenant database migration failed.',
  [TenantProvisioningErrorCode.IDENTITY_MISMATCH]:
    'Tenant database identity does not match the requested store.',
  [TenantProvisioningErrorCode.IDENTITY_INITIALIZATION_FAILED]:
    'Tenant database identity could not be initialized.',
  [TenantProvisioningErrorCode.VERIFICATION_FAILED]:
    'Tenant database identity could not be verified.',
  [TenantProvisioningErrorCode.IDENTITY_CLEANUP_FAILED]:
    'Tenant database identity connection could not be closed.',
  [TenantProvisioningErrorCode.STORE_NOT_FOUND]: 'Store was not found.',
  [TenantProvisioningErrorCode.PROVISIONING_NOT_FOUND]:
    'Tenant provisioning record was not found.',
  [TenantProvisioningErrorCode.IDENTIFIER_CONFLICT]:
    'Tenant database identifiers conflict with another record.',
  [TenantProvisioningErrorCode.RECORD_INTEGRITY_FAILED]:
    'Tenant provisioning record integrity validation failed.',
  [TenantProvisioningErrorCode.CONFIGURATION_DRIFT]:
    'Tenant provisioning configuration no longer matches the stored record.',
  [TenantProvisioningErrorCode.PROVISIONING_IN_PROGRESS]:
    'Tenant database provisioning is already in progress.',
  [TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT]:
    'Tenant provisioning state changed concurrently.',
  [TenantProvisioningErrorCode.PROVISIONING_FAILED]:
    'Tenant database provisioning failed.',
} as const satisfies Record<TenantProvisioningErrorCode, string>;

export class TenantProvisioningError extends Error {
  constructor(
    readonly code: TenantProvisioningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TenantProvisioningError';
  }
}

export function getTenantProvisioningSafeMessage(
  code: TenantProvisioningErrorCode,
): string {
  return TENANT_PROVISIONING_SAFE_MESSAGES[code];
}

export function createTenantProvisioningError(
  code: TenantProvisioningErrorCode,
): TenantProvisioningError {
  return new TenantProvisioningError(
    code,
    getTenantProvisioningSafeMessage(code),
  );
}
