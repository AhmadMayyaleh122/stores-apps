import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';

import {
  createStoreAuthError,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';

export const STORE_REFRESH_TOKEN_PREFIX = 'srt_';
export const STORE_REFRESH_TOKEN_BYTES = 32;
const BASE64URL_PAYLOAD_LENGTH = 43;
const REFRESH_TOKEN_PATTERN = new RegExp(
  `^${STORE_REFRESH_TOKEN_PREFIX}([A-Za-z0-9_-]{${BASE64URL_PAYLOAD_LENGTH}})$`,
);

export interface GeneratedRefreshToken {
  readonly rawToken: string;
  readonly tokenHash: Buffer;
}

@Injectable()
export class RefreshTokenService {
  generate(): GeneratedRefreshToken {
    let randomTokenBytes: Buffer | undefined;

    try {
      randomTokenBytes = crypto.randomBytes(STORE_REFRESH_TOKEN_BYTES);

      if (randomTokenBytes.length !== STORE_REFRESH_TOKEN_BYTES) {
        throw new Error('Unexpected refresh token length');
      }

      const rawToken = `${STORE_REFRESH_TOKEN_PREFIX}${randomTokenBytes.toString('base64url')}`;

      return {
        rawToken,
        tokenHash: this.hash(rawToken),
      };
    } catch (error) {
      if (
        error instanceof StoreAuthError &&
        error.code === StoreAuthErrorCode.REFRESH_TOKEN_HASHING_FAILED
      ) {
        throw createStoreAuthError(error.code);
      }

      throw createStoreAuthError(
        StoreAuthErrorCode.REFRESH_TOKEN_GENERATION_FAILED,
      );
    } finally {
      randomTokenBytes?.fill(0);
    }
  }

  parse(rawToken: unknown): string {
    if (typeof rawToken !== 'string') {
      throwInvalidRefreshToken();
    }

    const match = REFRESH_TOKEN_PATTERN.exec(rawToken);

    if (!match) {
      throwInvalidRefreshToken();
    }

    let decodedPayload: Buffer | undefined;

    try {
      decodedPayload = Buffer.from(match[1], 'base64url');

      if (
        decodedPayload.length !== STORE_REFRESH_TOKEN_BYTES ||
        decodedPayload.toString('base64url') !== match[1]
      ) {
        throwInvalidRefreshToken();
      }

      return rawToken;
    } catch (error) {
      if (error instanceof StoreAuthError) {
        throw error;
      }

      return throwInvalidRefreshToken();
    } finally {
      decodedPayload?.fill(0);
    }
  }

  hash(rawToken: unknown): Buffer {
    const canonicalToken = this.parse(rawToken);

    try {
      return crypto
        .createHash('sha256')
        .update(canonicalToken, 'ascii')
        .digest();
    } catch {
      throw createStoreAuthError(
        StoreAuthErrorCode.REFRESH_TOKEN_HASHING_FAILED,
      );
    }
  }

  verify(rawToken: unknown, expectedHash: unknown): boolean {
    let actualHash: Buffer | undefined;

    try {
      if (!Buffer.isBuffer(expectedHash) || expectedHash.length !== 32) {
        return false;
      }

      actualHash = this.hash(rawToken);
      return crypto.timingSafeEqual(actualHash, expectedHash);
    } catch {
      return false;
    } finally {
      actualHash?.fill(0);
    }
  }
}

function throwInvalidRefreshToken(): never {
  throw createStoreAuthError(StoreAuthErrorCode.REFRESH_TOKEN_INVALID);
}
