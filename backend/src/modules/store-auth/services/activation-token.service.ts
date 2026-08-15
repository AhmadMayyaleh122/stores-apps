import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';

import {
  createStoreAuthError,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';

export const STORE_OWNER_ACTIVATION_TOKEN_PREFIX = 'soa_';
export const STORE_OWNER_ACTIVATION_TOKEN_BYTES = 32;
const BASE64URL_PAYLOAD_LENGTH = 43;
const TOKEN_PATTERN = new RegExp(
  `^${STORE_OWNER_ACTIVATION_TOKEN_PREFIX}([A-Za-z0-9_-]{${BASE64URL_PAYLOAD_LENGTH}})$`,
);

export interface GeneratedActivationToken {
  rawToken: string;
  tokenHash: Buffer;
}

@Injectable()
export class ActivationTokenService {
  generate(): GeneratedActivationToken {
    let randomTokenBytes: Buffer | undefined;

    try {
      randomTokenBytes = crypto.randomBytes(
        STORE_OWNER_ACTIVATION_TOKEN_BYTES,
      );

      if (randomTokenBytes.length !== STORE_OWNER_ACTIVATION_TOKEN_BYTES) {
        throw new Error('Unexpected random token length');
      }

      const rawToken = `${STORE_OWNER_ACTIVATION_TOKEN_PREFIX}${randomTokenBytes.toString('base64url')}`;

      return {
        rawToken,
        tokenHash: this.hash(rawToken),
      };
    } catch {
      throw createStoreAuthError(
        StoreAuthErrorCode.ACTIVATION_TOKEN_GENERATION_FAILED,
      );
    } finally {
      randomTokenBytes?.fill(0);
    }
  }

  parse(rawToken: string): string {
    if (typeof rawToken !== 'string') {
      throwInvalidToken();
    }

    const match = TOKEN_PATTERN.exec(rawToken);

    if (!match) {
      throwInvalidToken();
    }

    const encodedPayload = match[1];
    let decodedPayload: Buffer | undefined;

    try {
      decodedPayload = Buffer.from(encodedPayload, 'base64url');

      if (
        decodedPayload.length !== STORE_OWNER_ACTIVATION_TOKEN_BYTES ||
        decodedPayload.toString('base64url') !== encodedPayload
      ) {
        throwInvalidToken();
      }

      return rawToken;
    } catch (error) {
      if (error instanceof StoreAuthError) {
        throw error;
      }

      return throwInvalidToken();
    } finally {
      decodedPayload?.fill(0);
    }
  }

  hash(rawToken: string): Buffer {
    const canonicalToken = this.parse(rawToken);

    try {
      return crypto
        .createHash('sha256')
        .update(canonicalToken, 'ascii')
        .digest();
    } catch {
      throw createStoreAuthError(
        StoreAuthErrorCode.ACTIVATION_TOKEN_HASHING_FAILED,
      );
    }
  }
}

function throwInvalidToken(): never {
  throw createStoreAuthError(StoreAuthErrorCode.ACTIVATION_TOKEN_INVALID);
}
