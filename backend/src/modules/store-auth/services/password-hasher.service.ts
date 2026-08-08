import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import {
  createStoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { PasswordPolicyService } from './password-policy.service';

export const STORE_PASSWORD_ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
});

@Injectable()
export class PasswordHasherService {
  constructor(private readonly passwordPolicy: PasswordPolicyService) {}

  async hash(password: string): Promise<string> {
    const normalizedPassword =
      this.passwordPolicy.normalizeAndValidate(password);

    try {
      return await argon2.hash(
        normalizedPassword,
        STORE_PASSWORD_ARGON2_OPTIONS,
      );
    } catch {
      throw createStoreAuthError(StoreAuthErrorCode.PASSWORD_HASHING_FAILED);
    }
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      const normalizedPassword =
        this.passwordPolicy.normalizeAndValidate(password);

      return await argon2.verify(passwordHash, normalizedPassword);
    } catch {
      return false;
    }
  }
}
