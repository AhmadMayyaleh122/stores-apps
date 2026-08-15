import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { normalizeCanonicalUuid } from '../../tenant-provisioning/utils/tenant-database-identifier.util';
import {
  createStoreAuthError,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import {
  StoreAuthSessionConfigService,
  STORE_AUTH_ACCESS_TOKEN_ALGORITHM,
} from './store-auth-session-config.service';

const MAX_ACCESS_TOKEN_LENGTH = 4_096;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface IssueStoreAccessTokenInput {
  readonly ownerId: string;
  readonly storeId: string;
  readonly sessionId: string;
  readonly issuedAt: Date;
}

export interface IssuedStoreAccessToken {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

export interface StoreAccessTokenClaims {
  readonly sub: string;
  readonly storeId: string;
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly aud: string;
}

@Injectable()
export class StoreAccessTokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: StoreAuthSessionConfigService,
  ) {}

  async issue(
    input: IssueStoreAccessTokenInput,
  ): Promise<IssuedStoreAccessToken> {
    let signingKey: Buffer | undefined;

    try {
      const configuration =
        this.configService.getAuthenticationConfiguration();
      const ownerId = normalizeCanonicalUuid(input.ownerId);
      const storeId = normalizeCanonicalUuid(input.storeId);
      const sessionId = normalizeCanonicalUuid(input.sessionId);
      const issuedAtMilliseconds = requireWholeSecondDate(input.issuedAt);
      const issuedAtSeconds = issuedAtMilliseconds / 1_000;
      const expiresAtMilliseconds = calculateAccessTokenExpiration(
        issuedAtMilliseconds,
        configuration.accessTokenTtlSeconds,
      );
      signingKey = configuration.signingKey.copyKeyMaterial();

      const accessToken = await this.jwtService.signAsync(
        {
          sub: ownerId,
          storeId,
          sid: sessionId,
          iat: issuedAtSeconds,
        },
        {
          secret: signingKey,
          algorithm: STORE_AUTH_ACCESS_TOKEN_ALGORITHM,
          issuer: configuration.accessTokenIssuer,
          audience: configuration.accessTokenAudience,
          expiresIn: configuration.accessTokenTtlSeconds,
        },
      );

      if (
        typeof accessToken !== 'string' ||
        accessToken.length === 0 ||
        accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
        !JWT_PATTERN.test(accessToken)
      ) {
        throw new Error('Invalid signed access token');
      }

      return Object.freeze({
        accessToken,
        expiresAt: new Date(expiresAtMilliseconds),
      });
    } catch (error) {
      if (
        error instanceof StoreAuthError &&
        error.code ===
          StoreAuthErrorCode.AUTHENTICATION_CONFIGURATION_INVALID
      ) {
        throw createStoreAuthError(error.code);
      }

      throw createStoreAuthError(
        StoreAuthErrorCode.ACCESS_TOKEN_ISSUANCE_FAILED,
      );
    } finally {
      signingKey?.fill(0);
    }
  }

  async verify(accessToken: unknown): Promise<StoreAccessTokenClaims> {
    let signingKey: Buffer | undefined;

    try {
      if (
        typeof accessToken !== 'string' ||
        accessToken.length === 0 ||
        accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
        !JWT_PATTERN.test(accessToken)
      ) {
        throw invalidAccessToken();
      }

      const configuration =
        this.configService.getAuthenticationConfiguration();
      signingKey = configuration.signingKey.copyKeyMaterial();
      const payload = await this.jwtService.verifyAsync<
        Record<string, unknown>
      >(accessToken, {
        secret: signingKey,
        algorithms: [STORE_AUTH_ACCESS_TOKEN_ALGORITHM],
        issuer: configuration.accessTokenIssuer,
        audience: configuration.accessTokenAudience,
      });

      return requireAccessTokenClaims(
        payload,
        configuration.accessTokenIssuer,
        configuration.accessTokenAudience,
      );
    } catch (error) {
      if (
        error instanceof StoreAuthError &&
        error.code ===
          StoreAuthErrorCode.AUTHENTICATION_CONFIGURATION_INVALID
      ) {
        throw createStoreAuthError(error.code);
      }

      throw invalidAccessToken();
    } finally {
      signingKey?.fill(0);
    }
  }
}

function requireWholeSecondDate(value: unknown): number {
  if (!(value instanceof Date)) {
    throw new Error('Invalid access token issue time');
  }

  const milliseconds = value.getTime();

  if (!Number.isSafeInteger(milliseconds) || milliseconds % 1_000 !== 0) {
    throw new Error('Invalid access token issue time');
  }

  return milliseconds;
}

function calculateAccessTokenExpiration(
  issuedAtMilliseconds: number,
  ttlSeconds: number,
): number {
  const ttlMilliseconds = ttlSeconds * 1_000;
  const expiresAtMilliseconds = issuedAtMilliseconds + ttlMilliseconds;

  if (
    !Number.isSafeInteger(ttlMilliseconds) ||
    !Number.isSafeInteger(expiresAtMilliseconds) ||
    !Number.isFinite(new Date(expiresAtMilliseconds).getTime()) ||
    expiresAtMilliseconds <= issuedAtMilliseconds
  ) {
    throw new Error('Invalid access token expiration');
  }

  return expiresAtMilliseconds;
}

function requireAccessTokenClaims(
  value: unknown,
  expectedIssuer: string,
  expectedAudience: string,
): StoreAccessTokenClaims {
  if (typeof value !== 'object' || value === null) {
    throw invalidAccessToken();
  }

  const payload = value as Record<string, unknown>;
  const claimNames = Object.keys(payload).sort();
  const sub = normalizeCanonicalUuid(payload.sub as string);
  const storeId = normalizeCanonicalUuid(payload.storeId as string);
  const sid = normalizeCanonicalUuid(payload.sid as string);

  if (
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    (payload.iat as number) < 1 ||
    (payload.exp as number) <= (payload.iat as number) ||
    payload.iss !== expectedIssuer ||
    payload.aud !== expectedAudience ||
    claimNames.length !== 7 ||
    !['aud', 'exp', 'iat', 'iss', 'sid', 'storeId', 'sub'].every(
      (claimName, index) => claimNames[index] === claimName,
    )
  ) {
    throw invalidAccessToken();
  }

  return Object.freeze({
    sub,
    storeId,
    sid,
    iat: payload.iat as number,
    exp: payload.exp as number,
    iss: expectedIssuer,
    aud: expectedAudience,
  });
}

function invalidAccessToken(): StoreAuthError {
  return createStoreAuthError(StoreAuthErrorCode.ACCESS_TOKEN_INVALID);
}
