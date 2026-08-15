import { Injectable } from '@nestjs/common';

import {
  createStoreAuthError,
  STORE_AUTH_SAFE_MESSAGES,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { ActivationTokenService } from './activation-token.service';
import { PasswordHasherService } from './password-hasher.service';
import { PasswordPolicyService } from './password-policy.service';
import { StoreOwnerActivationConfigService } from './store-owner-activation-config.service';
import { StoreTenantAccessService } from './store-tenant-access.service';

export const STORE_OWNER_ACTIVATION_TOKEN_MAX_ATTEMPTS = 3;

export interface IssueStoreOwnerActivationResult {
  readonly rawToken: string;
  readonly expiresAt: Date;
}

export interface ActivateStoreOwnerResult {
  readonly activatedAt: Date;
}

@Injectable()
export class StoreOwnerActivationService {
  constructor(
    private readonly tenantAccessService: StoreTenantAccessService,
    private readonly activationTokenService: ActivationTokenService,
    private readonly passwordPolicyService: PasswordPolicyService,
    private readonly passwordHasherService: PasswordHasherService,
    private readonly activationConfigService: StoreOwnerActivationConfigService,
  ) {}

  async issueOwnerActivation(
    storeSlug: unknown,
  ): Promise<IssueStoreOwnerActivationResult> {
    try {
      const { ttlMinutes } =
        this.activationConfigService.getActivationConfiguration();

      for (
        let attempt = 0;
        attempt < STORE_OWNER_ACTIVATION_TOKEN_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const generatedToken = this.activationTokenService.generate();

        try {
          const outcome = await this.tenantAccessService.withResolvedTenant(
            storeSlug,
            ({ tenantAccess }) =>
              tenantAccess.issueOwnerActivation({
                tokenHash: generatedToken.tokenHash,
                ttlMinutes,
              }),
          );

          if (outcome !== 'TOKEN_HASH_COLLISION') {
            return Object.freeze({
              rawToken: generatedToken.rawToken,
              expiresAt: new Date(outcome.expiresAt.getTime()),
            });
          }
        } finally {
          generatedToken.tokenHash.fill(0);
        }
      }

      throw createStoreAuthError(
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
      );
    } catch (error) {
      throw sanitizeApplicationError(
        error,
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
      );
    }
  }

  async activateOwner(
    storeSlug: unknown,
    rawActivationToken: unknown,
    newPassword: unknown,
  ): Promise<ActivateStoreOwnerResult> {
    let tokenHash: Buffer | undefined;

    try {
      const canonicalToken = parseActivationToken(
        this.activationTokenService,
        rawActivationToken,
      );
      const activationTokenHash =
        this.activationTokenService.hash(canonicalToken);
      tokenHash = activationTokenHash;
      const advisoryEligible = await this.tenantAccessService.withResolvedTenant(
        storeSlug,
        ({ tenantAccess }) =>
          tenantAccess.checkOwnerActivationEligibility({
            tokenHash: activationTokenHash,
          }),
      );

      if (!advisoryEligible) {
        throw createStoreAuthError(StoreAuthErrorCode.OWNER_ACTIVATION_INVALID);
      }

      const normalizedPassword =
        this.passwordPolicyService.normalizeAndValidate(
          newPassword as string,
        );
      const passwordHash = await this.passwordHasherService.hash(
        normalizedPassword,
      );

      const outcome = await this.tenantAccessService.withResolvedTenant(
        storeSlug,
        ({ tenantAccess }) =>
          tenantAccess.activateOwner({
            tokenHash: activationTokenHash,
            passwordHash,
          }),
      );

      return Object.freeze({
        activatedAt: new Date(outcome.activatedAt.getTime()),
      });
    } catch (error) {
      throw sanitizeApplicationError(
        error,
        StoreAuthErrorCode.OWNER_ACTIVATION_FAILED,
      );
    } finally {
      tokenHash?.fill(0);
    }
  }
}

function parseActivationToken(
  activationTokenService: ActivationTokenService,
  rawActivationToken: unknown,
): string {
  try {
    return activationTokenService.parse(rawActivationToken as string);
  } catch (error) {
    if (
      error instanceof StoreAuthError &&
      error.code === StoreAuthErrorCode.ACTIVATION_TOKEN_INVALID
    ) {
      throw createStoreAuthError(StoreAuthErrorCode.OWNER_ACTIVATION_INVALID);
    }

    throw error;
  }
}

function sanitizeApplicationError(
  error: unknown,
  fallbackCode:
    | StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED
    | StoreAuthErrorCode.OWNER_ACTIVATION_FAILED,
): StoreAuthError {
  if (
    error instanceof StoreAuthError &&
    Object.prototype.hasOwnProperty.call(STORE_AUTH_SAFE_MESSAGES, error.code)
  ) {
    return createStoreAuthError(error.code);
  }

  return createStoreAuthError(fallbackCode);
}
