import { Injectable } from '@nestjs/common';

import { normalizeCanonicalUuid } from '../../tenant-provisioning/utils/tenant-database-identifier.util';
import { normalizeTenantOwnerEmail } from '../../tenant-provisioning/utils/tenant-owner-email.util';
import {
  createStoreAuthError,
  STORE_AUTH_SAFE_MESSAGES,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { RefreshTokenService } from './refresh-token.service';
import { StoreAccessTokenService } from './store-access-token.service';
import { StoreAuthSessionConfigService } from './store-auth-session-config.service';
import { AuthenticatedStoreOwner } from './store-owner-login.service';
import { StoreTenantAccessService } from './store-tenant-access.service';

export const STORE_AUTH_REFRESH_TOKEN_MAX_ATTEMPTS = 3;

export interface StoreAuthenticationState {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

@Injectable()
export class StoreAuthenticationSessionService {
  constructor(
    private readonly tenantAccessService: StoreTenantAccessService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly accessTokenService: StoreAccessTokenService,
    private readonly configService: StoreAuthSessionConfigService,
  ) {}

  async createOwnerAuthenticationState(
    storeSlug: unknown,
    authenticatedOwner: AuthenticatedStoreOwner,
  ): Promise<StoreAuthenticationState> {
    try {
      const owner = requireAuthenticatedOwner(authenticatedOwner);
      const { refreshTokenTtlMinutes } =
        this.configService.getAuthenticationConfiguration();

      for (
        let attempt = 0;
        attempt < STORE_AUTH_REFRESH_TOKEN_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const generatedRefreshToken = this.refreshTokenService.generate();

        try {
          const session = await this.tenantAccessService.withResolvedTenant(
            storeSlug,
            ({ storeId, tenantAccess }) => {
              if (storeId !== owner.storeId) {
                throw createStoreAuthError(
                  StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
                );
              }

              return tenantAccess.createOwnerRefreshSession({
                ownerId: owner.ownerId,
                refreshTokenHash: generatedRefreshToken.tokenHash,
                ttlMinutes: refreshTokenTtlMinutes,
              });
            },
          );

          if (session === 'REFRESH_TOKEN_HASH_COLLISION') {
            continue;
          }

          const accessToken = await this.accessTokenService.issue({
            ownerId: owner.ownerId,
            storeId: owner.storeId,
            sessionId: session.sessionId,
            issuedAt: session.issuedAt,
          });

          return Object.freeze({
            accessToken: accessToken.accessToken,
            accessTokenExpiresAt: new Date(accessToken.expiresAt.getTime()),
            refreshToken: generatedRefreshToken.rawToken,
            refreshTokenExpiresAt: new Date(session.expiresAt.getTime()),
          });
        } finally {
          generatedRefreshToken.tokenHash.fill(0);
        }
      }

      throw createStoreAuthError(
        StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
      );
    } catch (error) {
      if (
        error instanceof StoreAuthError &&
        Object.prototype.hasOwnProperty.call(
          STORE_AUTH_SAFE_MESSAGES,
          error.code,
        )
      ) {
        throw createStoreAuthError(error.code);
      }

      throw createStoreAuthError(
        StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
      );
    }
  }
}

function requireAuthenticatedOwner(
  value: unknown,
): AuthenticatedStoreOwner {
  if (typeof value !== 'object' || value === null) {
    throw createStoreAuthError(StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID);
  }

  const owner = value as Record<string, unknown>;

  try {
    const storeId = normalizeCanonicalUuid(owner.storeId as string);
    const ownerId = normalizeCanonicalUuid(owner.ownerId as string);
    const email = normalizeTenantOwnerEmail(owner.email);

    if (email === null || email !== owner.email) {
      throw new Error('Invalid authenticated owner email');
    }

    return Object.freeze({ storeId, ownerId, email });
  } catch {
    throw createStoreAuthError(StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID);
  }
}
