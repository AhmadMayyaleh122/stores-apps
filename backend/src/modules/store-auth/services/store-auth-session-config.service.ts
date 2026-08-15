import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  createStoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';

export const STORE_AUTH_ACCESS_TOKEN_ALGORITHM = 'HS256' as const;
export const DEFAULT_STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS = 900;
export const MIN_STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS = 60;
export const MAX_STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS = 3_600;
export const DEFAULT_STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES = 43_200;
export const MIN_STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES = 60;
export const MAX_STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES = 525_600;
export const DEFAULT_STORE_AUTH_ACCESS_TOKEN_ISSUER =
  'white-label-commerce-store-auth';
export const DEFAULT_STORE_AUTH_ACCESS_TOKEN_AUDIENCE =
  'white-label-commerce-store-mobile';

const MIN_SIGNING_KEY_BYTES = 32;
const MAX_SIGNING_KEY_BYTES = 64;
const MAX_CLAIM_CONTEXT_LENGTH = 200;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export interface StoreAuthSessionConfiguration {
  readonly accessTokenAlgorithm: typeof STORE_AUTH_ACCESS_TOKEN_ALGORITHM;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlMinutes: number;
  readonly accessTokenIssuer: string;
  readonly accessTokenAudience: string;
  readonly signingKey: StoreAuthAccessTokenSigningKey;
}

export class StoreAuthAccessTokenSigningKey {
  readonly #keyMaterial: Buffer;

  constructor(keyMaterial: Buffer) {
    this.#keyMaterial = Buffer.from(keyMaterial);
    Object.freeze(this);
  }

  copyKeyMaterial(): Buffer {
    return Buffer.from(this.#keyMaterial);
  }
}

@Injectable()
export class StoreAuthSessionConfigService {
  constructor(private readonly configService: ConfigService) {}

  getAuthenticationConfiguration(): StoreAuthSessionConfiguration {
    try {
      const accessTokenAlgorithm = readAlgorithm(
        this.configService.get<unknown>(
          'STORE_AUTH_ACCESS_TOKEN_ALGORITHM',
        ),
      );
      const accessTokenTtlSeconds = readBoundedPositiveInteger(
        this.configService.get<unknown>(
          'STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS',
        ),
        DEFAULT_STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS,
        MIN_STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS,
        MAX_STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS,
      );
      const refreshTokenTtlMinutes = readBoundedPositiveInteger(
        this.configService.get<unknown>(
          'STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES',
        ),
        DEFAULT_STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES,
        MIN_STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES,
        MAX_STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES,
      );
      const accessTokenIssuer = readClaimContext(
        this.configService.get<unknown>('STORE_AUTH_ACCESS_TOKEN_ISSUER'),
        DEFAULT_STORE_AUTH_ACCESS_TOKEN_ISSUER,
      );
      const accessTokenAudience = readClaimContext(
        this.configService.get<unknown>('STORE_AUTH_ACCESS_TOKEN_AUDIENCE'),
        DEFAULT_STORE_AUTH_ACCESS_TOKEN_AUDIENCE,
      );
      const signingKey = readSigningKey(
        this.configService.get<unknown>('STORE_AUTH_ACCESS_TOKEN_SECRET'),
      );

      return Object.freeze({
        accessTokenAlgorithm,
        accessTokenTtlSeconds,
        refreshTokenTtlMinutes,
        accessTokenIssuer,
        accessTokenAudience,
        signingKey,
      });
    } catch {
      throw createStoreAuthError(
        StoreAuthErrorCode.AUTHENTICATION_CONFIGURATION_INVALID,
      );
    }
  }
}

function readAlgorithm(
  value: unknown,
): typeof STORE_AUTH_ACCESS_TOKEN_ALGORITHM {
  const algorithm = value ?? STORE_AUTH_ACCESS_TOKEN_ALGORITHM;

  if (algorithm !== STORE_AUTH_ACCESS_TOKEN_ALGORITHM) {
    throw new Error('Unsupported access token algorithm');
  }

  return STORE_AUTH_ACCESS_TOKEN_ALGORITHM;
}

function readBoundedPositiveInteger(
  value: unknown,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? defaultValue;
  const normalized =
    typeof candidate === 'number' ? String(candidate) : candidate;

  if (typeof normalized !== 'string' || !/^[1-9]\d*$/.test(normalized)) {
    throw new Error('Invalid authentication duration');
  }

  const parsed = Number(normalized);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error('Invalid authentication duration');
  }

  return parsed;
}

function readClaimContext(value: unknown, defaultValue: string): string {
  const candidate = value ?? defaultValue;

  if (typeof candidate !== 'string') {
    throw new Error('Invalid access token claim context');
  }

  const normalized = candidate.trim();

  if (
    normalized.length === 0 ||
    normalized.length > MAX_CLAIM_CONTEXT_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw new Error('Invalid access token claim context');
  }

  return normalized;
}

function readSigningKey(value: unknown): StoreAuthAccessTokenSigningKey {
  if (
    typeof value !== 'string' ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new Error('Invalid access token signing key');
  }

  const decoded = Buffer.from(value, 'base64url');

  try {
    if (
      decoded.length < MIN_SIGNING_KEY_BYTES ||
      decoded.length > MAX_SIGNING_KEY_BYTES ||
      decoded.toString('base64url') !== value
    ) {
      throw new Error('Invalid access token signing key');
    }

    return new StoreAuthAccessTokenSigningKey(decoded);
  } finally {
    decoded.fill(0);
  }
}
