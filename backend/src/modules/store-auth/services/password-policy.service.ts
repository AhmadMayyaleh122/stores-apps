import { Injectable } from '@nestjs/common';

import {
  createStoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';

export const STORE_PASSWORD_MIN_CODE_POINTS = 15;
export const STORE_PASSWORD_MAX_CODE_POINTS = 128;

@Injectable()
export class PasswordPolicyService {
  normalizeAndValidate(password: string): string {
    if (typeof password !== 'string') {
      throwInvalidPassword();
    }

    let normalizedPassword: string;

    try {
      normalizedPassword = password.normalize('NFC');
    } catch {
      throwInvalidPassword();
    }

    const codePointCount = Array.from(normalizedPassword).length;

    if (
      codePointCount < STORE_PASSWORD_MIN_CODE_POINTS ||
      codePointCount > STORE_PASSWORD_MAX_CODE_POINTS
    ) {
      throwInvalidPassword();
    }

    return normalizedPassword;
  }
}

function throwInvalidPassword(): never {
  throw createStoreAuthError(StoreAuthErrorCode.PASSWORD_POLICY_INVALID);
}
