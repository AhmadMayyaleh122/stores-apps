import { Injectable } from '@nestjs/common';

import {
  createStoreAuthError,
  STORE_AUTH_SAFE_MESSAGES,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { RefreshTokenService } from './refresh-token.service';
import { StoreTenantAccessService } from './store-tenant-access.service';

@Injectable()
export class StoreAuthenticationLogoutService {
  constructor(
    private readonly tenantAccessService: StoreTenantAccessService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  async logoutOwnerSession(
    storeSlug: unknown,
    rawRefreshToken: unknown,
  ): Promise<void> {
    try {
      await this.tenantAccessService.withResolvedTenant(
        storeSlug,
        async ({ tenantAccess }) => {
          let refreshTokenHash: Buffer;

          try {
            refreshTokenHash =
              this.refreshTokenService.hash(rawRefreshToken);
          } catch (error) {
            if (
              error instanceof StoreAuthError &&
              error.code === StoreAuthErrorCode.REFRESH_TOKEN_INVALID
            ) {
              return;
            }

            throw error;
          }

          try {
            await tenantAccess.revokeOwnerRefreshSession({
              refreshTokenHash,
            });
          } finally {
            refreshTokenHash.fill(0);
          }
        },
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

      throw createStoreAuthError(StoreAuthErrorCode.AUTH_LOGOUT_FAILED);
    }
  }
}
