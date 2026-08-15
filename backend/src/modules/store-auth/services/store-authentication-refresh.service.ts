import { Injectable } from '@nestjs/common';

import {
  createStoreAuthError,
  STORE_AUTH_SAFE_MESSAGES,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { RefreshTokenService } from './refresh-token.service';
import { StoreAccessTokenService } from './store-access-token.service';
import { StoreAuthenticationState } from './store-authentication-session.service';
import { StoreAuthSessionConfigService } from './store-auth-session-config.service';
import { StoreTenantAccessService } from './store-tenant-access.service';

export const STORE_AUTH_REFRESH_ROTATION_MAX_ATTEMPTS = 3;

@Injectable()
export class StoreAuthenticationRefreshService {
  constructor(
    private readonly tenantAccessService: StoreTenantAccessService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly accessTokenService: StoreAccessTokenService,
    private readonly configService: StoreAuthSessionConfigService,
  ) {}

  async refreshOwnerAuthenticationState(
    storeSlug: unknown,
    rawRefreshToken: unknown,
  ): Promise<StoreAuthenticationState> {
    try {
      return await this.tenantAccessService.withResolvedTenant(
        storeSlug,
        async ({ tenantAccess }) => {
          const presentedHash = this.refreshTokenService.hash(rawRefreshToken);

          try {
            const { refreshTokenTtlMinutes } =
              this.configService.getAuthenticationConfiguration();

            for (
              let attempt = 0;
              attempt < STORE_AUTH_REFRESH_ROTATION_MAX_ATTEMPTS;
              attempt += 1
            ) {
              const replacement = this.refreshTokenService.generate();

              try {
                if (replacement.tokenHash.equals(presentedHash)) {
                  continue;
                }

                const outcome = await tenantAccess.rotateOwnerRefreshSession(
                  {
                    presentedRefreshTokenHash: presentedHash,
                    replacementRefreshTokenHash: replacement.tokenHash,
                    ttlMinutes: refreshTokenTtlMinutes,
                  },
                  (authenticationContext) =>
                    this.accessTokenService.issue(authenticationContext),
                );

                if (outcome === 'REFRESH_TOKEN_HASH_COLLISION') {
                  continue;
                }

                if (
                  outcome === 'INVALID_REFRESH' ||
                  outcome === 'INVALID_REFRESH_REVOKED'
                ) {
                  throw createStoreAuthError(
                    StoreAuthErrorCode.AUTH_REFRESH_INVALID,
                  );
                }

                return Object.freeze({
                  accessToken: outcome.accessToken,
                  accessTokenExpiresAt: new Date(
                    outcome.accessTokenExpiresAt.getTime(),
                  ),
                  refreshToken: replacement.rawToken,
                  refreshTokenExpiresAt: new Date(
                    outcome.refreshTokenExpiresAt.getTime(),
                  ),
                });
              } finally {
                replacement.tokenHash.fill(0);
              }
            }

            throw createStoreAuthError(StoreAuthErrorCode.AUTH_REFRESH_FAILED);
          } finally {
            presentedHash.fill(0);
          }
        },
      );
    } catch (error) {
      if (
        error instanceof StoreAuthError &&
        error.code === StoreAuthErrorCode.REFRESH_TOKEN_INVALID
      ) {
        throw createStoreAuthError(StoreAuthErrorCode.AUTH_REFRESH_INVALID);
      }

      if (
        error instanceof StoreAuthError &&
        Object.prototype.hasOwnProperty.call(
          STORE_AUTH_SAFE_MESSAGES,
          error.code,
        )
      ) {
        throw createStoreAuthError(error.code);
      }

      throw createStoreAuthError(StoreAuthErrorCode.AUTH_REFRESH_FAILED);
    }
  }
}
