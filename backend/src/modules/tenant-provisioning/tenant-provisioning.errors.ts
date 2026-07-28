export enum TenantProvisioningErrorCode {
  IDENTIFIER_INVALID = 'TENANT_IDENTIFIER_INVALID',
  DATABASE_URL_INVALID = 'TENANT_DATABASE_URL_INVALID',
  CONFIGURATION_INVALID = 'TENANT_PROVISIONING_CONFIGURATION_INVALID',
  ENCRYPTION_KEY_INVALID = 'TENANT_ENCRYPTION_KEY_INVALID',
  CREDENTIAL_ENCRYPTION_FAILED = 'TENANT_CREDENTIAL_ENCRYPTION_FAILED',
  CREDENTIAL_DECRYPTION_FAILED = 'TENANT_CREDENTIAL_DECRYPTION_FAILED',
}

export class TenantProvisioningError extends Error {
  constructor(
    readonly code: TenantProvisioningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TenantProvisioningError';
  }
}
