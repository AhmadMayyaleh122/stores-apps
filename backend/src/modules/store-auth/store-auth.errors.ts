export enum StoreAuthErrorCode {
  PASSWORD_POLICY_INVALID = 'STORE_AUTH_PASSWORD_POLICY_INVALID',
  PASSWORD_HASHING_FAILED = 'STORE_AUTH_PASSWORD_HASHING_FAILED',
  ACTIVATION_TOKEN_INVALID = 'STORE_AUTH_ACTIVATION_TOKEN_INVALID',
  ACTIVATION_TOKEN_GENERATION_FAILED =
    'STORE_AUTH_ACTIVATION_TOKEN_GENERATION_FAILED',
  ACTIVATION_TOKEN_HASHING_FAILED =
    'STORE_AUTH_ACTIVATION_TOKEN_HASHING_FAILED',
  CONFIGURATION_INVALID = 'STORE_AUTH_CONFIGURATION_INVALID',
  STORE_SLUG_INVALID = 'STORE_AUTH_STORE_SLUG_INVALID',
  TENANT_UNAVAILABLE = 'STORE_AUTH_TENANT_UNAVAILABLE',
  TENANT_CONFIGURATION_INVALID =
    'STORE_AUTH_TENANT_CONFIGURATION_INVALID',
  TENANT_IDENTITY_INVALID = 'STORE_AUTH_TENANT_IDENTITY_INVALID',
  TENANT_ACCESS_FAILED = 'STORE_AUTH_TENANT_ACCESS_FAILED',
  TENANT_CLEANUP_FAILED = 'STORE_AUTH_TENANT_CLEANUP_FAILED',
  OWNER_ACTIVATION_ISSUANCE_CONFLICT =
    'STORE_AUTH_OWNER_ACTIVATION_ISSUANCE_CONFLICT',
  OWNER_ACTIVATION_ISSUANCE_FAILED =
    'STORE_AUTH_OWNER_ACTIVATION_ISSUANCE_FAILED',
  OWNER_ACTIVATION_INVALID = 'STORE_AUTH_OWNER_ACTIVATION_INVALID',
  OWNER_ACTIVATION_FAILED = 'STORE_AUTH_OWNER_ACTIVATION_FAILED',
  INVALID_STORE_CREDENTIALS = 'STORE_AUTH_INVALID_STORE_CREDENTIALS',
  AUTHENTICATION_CONFIGURATION_INVALID =
    'STORE_AUTH_AUTHENTICATION_CONFIGURATION_INVALID',
  ACCESS_TOKEN_ISSUANCE_FAILED = 'STORE_AUTH_ACCESS_TOKEN_ISSUANCE_FAILED',
  ACCESS_TOKEN_INVALID = 'STORE_AUTH_ACCESS_TOKEN_INVALID',
  REFRESH_TOKEN_GENERATION_FAILED =
    'STORE_AUTH_REFRESH_TOKEN_GENERATION_FAILED',
  REFRESH_TOKEN_HASHING_FAILED = 'STORE_AUTH_REFRESH_TOKEN_HASHING_FAILED',
  REFRESH_TOKEN_INVALID = 'STORE_AUTH_REFRESH_TOKEN_INVALID',
  AUTH_SESSION_OWNER_INVALID = 'STORE_AUTH_AUTH_SESSION_OWNER_INVALID',
  AUTH_SESSION_CREATION_FAILED = 'STORE_AUTH_AUTH_SESSION_CREATION_FAILED',
  AUTH_REFRESH_INVALID = 'STORE_AUTH_AUTH_REFRESH_INVALID',
  AUTH_REFRESH_FAILED = 'STORE_AUTH_AUTH_REFRESH_FAILED',
  AUTH_LOGOUT_FAILED = 'STORE_AUTH_AUTH_LOGOUT_FAILED',
}

export const STORE_AUTH_SAFE_MESSAGES = {
  [StoreAuthErrorCode.PASSWORD_POLICY_INVALID]:
    'Password does not meet the required policy.',
  [StoreAuthErrorCode.PASSWORD_HASHING_FAILED]:
    'Password could not be secured.',
  [StoreAuthErrorCode.ACTIVATION_TOKEN_INVALID]:
    'Activation token is invalid.',
  [StoreAuthErrorCode.ACTIVATION_TOKEN_GENERATION_FAILED]:
    'Activation token could not be generated.',
  [StoreAuthErrorCode.ACTIVATION_TOKEN_HASHING_FAILED]:
    'Activation token could not be secured.',
  [StoreAuthErrorCode.CONFIGURATION_INVALID]:
    'Store owner activation configuration is invalid.',
  [StoreAuthErrorCode.STORE_SLUG_INVALID]: 'Store identifier is invalid.',
  [StoreAuthErrorCode.TENANT_UNAVAILABLE]: 'Store tenant is unavailable.',
  [StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID]:
    'Store tenant configuration is invalid.',
  [StoreAuthErrorCode.TENANT_IDENTITY_INVALID]:
    'Store tenant identity could not be verified.',
  [StoreAuthErrorCode.TENANT_ACCESS_FAILED]:
    'Store tenant could not be accessed.',
  [StoreAuthErrorCode.TENANT_CLEANUP_FAILED]:
    'Store tenant connection could not be closed.',
  [StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT]:
    'Store owner is not eligible for activation issuance.',
  [StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED]:
    'Store owner activation could not be issued.',
  [StoreAuthErrorCode.OWNER_ACTIVATION_INVALID]:
    'Store owner activation is invalid or no longer available.',
  [StoreAuthErrorCode.OWNER_ACTIVATION_FAILED]:
    'Store owner activation could not be completed.',
  [StoreAuthErrorCode.INVALID_STORE_CREDENTIALS]:
    'Store credentials are invalid.',
  [StoreAuthErrorCode.AUTHENTICATION_CONFIGURATION_INVALID]:
    'Store authentication configuration is invalid.',
  [StoreAuthErrorCode.ACCESS_TOKEN_ISSUANCE_FAILED]:
    'Store access token could not be issued.',
  [StoreAuthErrorCode.ACCESS_TOKEN_INVALID]:
    'Store access token is invalid or expired.',
  [StoreAuthErrorCode.REFRESH_TOKEN_GENERATION_FAILED]:
    'Store refresh token could not be generated.',
  [StoreAuthErrorCode.REFRESH_TOKEN_HASHING_FAILED]:
    'Store refresh token could not be secured.',
  [StoreAuthErrorCode.REFRESH_TOKEN_INVALID]:
    'Store refresh token is invalid.',
  [StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID]:
    'Store owner is not eligible for an authentication session.',
  [StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED]:
    'Store authentication session could not be created.',
  [StoreAuthErrorCode.AUTH_REFRESH_INVALID]:
    'Store refresh authentication is invalid or expired.',
  [StoreAuthErrorCode.AUTH_REFRESH_FAILED]:
    'Store authentication could not be refreshed.',
  [StoreAuthErrorCode.AUTH_LOGOUT_FAILED]:
    'Store authentication session could not be revoked.',
} as const satisfies Record<StoreAuthErrorCode, string>;

export class StoreAuthError extends Error {
  constructor(
    readonly code: StoreAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StoreAuthError';
  }
}

export function createStoreAuthError(
  code: StoreAuthErrorCode,
): StoreAuthError {
  return new StoreAuthError(code, STORE_AUTH_SAFE_MESSAGES[code]);
}
