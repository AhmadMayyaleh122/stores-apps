import { Injectable } from '@nestjs/common';

import { normalizeTenantOwnerEmail } from '../../tenant-provisioning/utils/tenant-owner-email.util';
import {
  createStoreAuthError,
  STORE_AUTH_SAFE_MESSAGES,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { PasswordHasherService } from './password-hasher.service';
import { StoreTenantAccessService } from './store-tenant-access.service';

export interface AuthenticatedStoreOwner {
  readonly storeId: string;
  readonly ownerId: string;
  readonly email: string;
}

@Injectable()
export class StoreOwnerLoginService {
  constructor(
    private readonly tenantAccessService: StoreTenantAccessService,
    private readonly passwordHasherService: PasswordHasherService,
  ) {}

  async authenticateOwner(
    storeSlug: unknown,
    email: unknown,
    password: unknown,
  ): Promise<AuthenticatedStoreOwner> {
    try {
      const canonicalEmail = normalizeTenantOwnerEmail(email);

      if (canonicalEmail === null) {
        throw invalidStoreCredentials();
      }

      return await this.tenantAccessService.withResolvedTenant(
        storeSlug,
        async ({ storeId, tenantAccess }) => {
          const candidate = await tenantAccess.findOwnerLoginCredential({
            email: canonicalEmail,
          });
          const passwordMatches =
            await this.passwordHasherService.verifyWithDummy(
              candidate?.passwordHash,
              password,
            );

          if (!candidate || !passwordMatches) {
            throw invalidStoreCredentials();
          }

          return Object.freeze({
            storeId,
            ownerId: candidate.ownerId,
            email: candidate.email,
          });
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

      throw invalidStoreCredentials();
    }
  }
}

function invalidStoreCredentials(): StoreAuthError {
  return createStoreAuthError(StoreAuthErrorCode.INVALID_STORE_CREDENTIALS);
}
