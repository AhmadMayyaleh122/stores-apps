export enum StoreAuthErrorCode {
  PASSWORD_POLICY_INVALID = 'STORE_AUTH_PASSWORD_POLICY_INVALID',
  PASSWORD_HASHING_FAILED = 'STORE_AUTH_PASSWORD_HASHING_FAILED',
  ACTIVATION_TOKEN_INVALID = 'STORE_AUTH_ACTIVATION_TOKEN_INVALID',
  ACTIVATION_TOKEN_GENERATION_FAILED =
    'STORE_AUTH_ACTIVATION_TOKEN_GENERATION_FAILED',
  ACTIVATION_TOKEN_HASHING_FAILED =
    'STORE_AUTH_ACTIVATION_TOKEN_HASHING_FAILED',
  CONFIGURATION_INVALID = 'STORE_AUTH_CONFIGURATION_INVALID',
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
