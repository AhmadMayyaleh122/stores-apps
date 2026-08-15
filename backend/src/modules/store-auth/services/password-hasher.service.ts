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

// This encoded value has no associated application secret. It exists only so
// missing credentials follow the same Argon2id verification path as real ones.
export const STORE_PASSWORD_DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$kvWU+X2SSp6Z5790fw8zug$npylD8PtUEAIn7XhZURLQTnScHcPENwRkCf3WTqy1FI';

const STORE_PASSWORD_HASH_PATTERN =
  /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

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

      if (!isSupportedPasswordHash(passwordHash)) {
        return false;
      }

      return await argon2.verify(passwordHash, normalizedPassword);
    } catch {
      return false;
    }
  }

  async verifyWithDummy(
    passwordHash: unknown,
    password: unknown,
  ): Promise<boolean> {
    const hasSupportedStoredHash = isSupportedPasswordHash(passwordHash);
    const verified = await this.verify(
      hasSupportedStoredHash ? passwordHash : STORE_PASSWORD_DUMMY_HASH,
      password as string,
    );

    return hasSupportedStoredHash && verified;
  }
}

function isSupportedPasswordHash(value: unknown): value is string {
  return typeof value === 'string' && STORE_PASSWORD_HASH_PATTERN.test(value);
}
