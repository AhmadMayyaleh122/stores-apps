import { PasswordHasherService } from './password-hasher.service';
import { PasswordPolicyService } from './password-policy.service';

import {
  createStoreAuthError,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { ActivationTokenService } from './activation-token.service';
import { StoreOwnerActivationConfigService } from './store-owner-activation-config.service';
import {
  STORE_OWNER_ACTIVATION_TOKEN_MAX_ATTEMPTS,
  StoreOwnerActivationService,
} from './store-owner-activation.service';
import {
  StoreAuthTenantAccess,
  StoreTenantAccessService,
} from './store-tenant-access.service';

describe('StoreOwnerActivationService', () => {
  const storeSlug = 'demo-store';
  const storeId = '12345678-1234-4234-8123-456789012345';
  const issuedAt = new Date('2026-08-10T12:00:00.000Z');
  const expiresAt = new Date('2026-08-11T12:00:00.000Z');
  const activatedAt = new Date('2026-08-10T12:05:00.000Z');
  const rawToken = `soa_${Buffer.alloc(32, 7).toString('base64url')}`;
  const tokenHash = Buffer.alloc(32, 11);
  const password = 'correct horse battery staple';
  const normalizedPassword = 'normalized password value';
  const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test$hash';
  let service: StoreOwnerActivationService;
  let tenantAccess: StoreAuthTenantAccess;
  let withResolvedTenant: jest.Mock;
  let checkOwnerActivationEligibility: jest.Mock;
  let findOwnerLoginCredential: jest.Mock;
  let issueOwnerActivation: jest.Mock;
  let activateOwner: jest.Mock;
  let generate: jest.Mock;
  let parse: jest.Mock;
  let hashToken: jest.Mock;
  let normalizeAndValidate: jest.Mock;
  let hashPassword: jest.Mock;
  let getActivationConfiguration: jest.Mock;

  beforeEach(() => {
    checkOwnerActivationEligibility = jest.fn().mockResolvedValue(true);
    findOwnerLoginCredential = jest.fn().mockResolvedValue(null);
    issueOwnerActivation = jest.fn().mockResolvedValue({
      issuedAt,
      expiresAt,
    });
    activateOwner = jest.fn().mockResolvedValue({ activatedAt });
    tenantAccess = Object.freeze({
      kind: 'STORE_AUTH_TENANT_ACCESS' as const,
      findOwnerLoginCredential,
      checkOwnerActivationEligibility,
      issueOwnerActivation,
      activateOwner,
      createOwnerRefreshSession: jest.fn(),
      rotateOwnerRefreshSession: jest.fn(),
      revokeOwnerRefreshSession: jest.fn(),
    });
    withResolvedTenant = jest.fn(
      async (
        _slug: unknown,
        operation: (context: {
          storeId: string;
          tenantAccess: StoreAuthTenantAccess;
        }) => unknown,
      ) => operation({ storeId, tenantAccess }),
    );
    generate = jest.fn().mockImplementation(() => ({
      rawToken,
      tokenHash: Buffer.from(tokenHash),
    }));
    parse = jest.fn().mockReturnValue(rawToken);
    hashToken = jest.fn().mockReturnValue(Buffer.from(tokenHash));
    normalizeAndValidate = jest.fn().mockReturnValue(normalizedPassword);
    hashPassword = jest.fn().mockResolvedValue(passwordHash);
    getActivationConfiguration = jest.fn().mockReturnValue({
      ttlMinutes: 1_440,
    });
    service = createService();
  });

  describe('issuance and reissue orchestration', () => {
    it('returns only the raw token and expiry committed by persistence', async () => {
      const result = await service.issueOwnerActivation(storeSlug);

      expect(result).toEqual({ rawToken, expiresAt });
      expect(Object.keys(result).sort()).toEqual(['expiresAt', 'rawToken']);
      expect(result).not.toHaveProperty('tokenHash');
      expect(result).not.toHaveProperty('issuedAt');
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('passes only a copied token hash and validated TTL to persistence', async () => {
      let persistedInput:
        | { tokenHash: Buffer; ttlMinutes: number }
        | undefined;
      issueOwnerActivation.mockImplementation(async (input) => {
        persistedInput = {
          tokenHash: Buffer.from(input.tokenHash),
          ttlMinutes: input.ttlMinutes,
        };
        return { issuedAt, expiresAt };
      });

      await service.issueOwnerActivation(storeSlug);

      expect(persistedInput).toEqual({ tokenHash, ttlMinutes: 1_440 });
      expect(persistedInput).not.toHaveProperty('rawToken');
      expect(persistedInput).not.toHaveProperty('issuedAt');
      expect(persistedInput).not.toHaveProperty('expiresAt');
    });

    it('regenerates the complete token after an exact hash collision', async () => {
      const secondRawToken = `soa_${Buffer.alloc(32, 8).toString('base64url')}`;
      const secondHash = Buffer.alloc(32, 12);
      generate
        .mockReturnValueOnce({ rawToken, tokenHash: Buffer.from(tokenHash) })
        .mockReturnValueOnce({
          rawToken: secondRawToken,
          tokenHash: Buffer.from(secondHash),
        });
      const attemptedHashes: Buffer[] = [];
      issueOwnerActivation
        .mockImplementationOnce(async (input) => {
          attemptedHashes.push(Buffer.from(input.tokenHash));
          return 'TOKEN_HASH_COLLISION';
        })
        .mockImplementationOnce(async (input) => {
          attemptedHashes.push(Buffer.from(input.tokenHash));
          return { issuedAt, expiresAt };
        });

      await expect(service.issueOwnerActivation(storeSlug)).resolves.toEqual({
        rawToken: secondRawToken,
        expiresAt,
      });
      expect(generate).toHaveBeenCalledTimes(2);
      expect(issueOwnerActivation).toHaveBeenCalledTimes(2);
      expect(attemptedHashes).toEqual([tokenHash, secondHash]);
    });

    it('limits collision handling to three total attempts', async () => {
      issueOwnerActivation.mockResolvedValue('TOKEN_HASH_COLLISION');

      await expectCode(
        service.issueOwnerActivation(storeSlug),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
      );
      expect(generate).toHaveBeenCalledTimes(
        STORE_OWNER_ACTIVATION_TOKEN_MAX_ATTEMPTS,
      );
      expect(issueOwnerActivation).toHaveBeenCalledTimes(
        STORE_OWNER_ACTIVATION_TOKEN_MAX_ATTEMPTS,
      );
    });

    it('does not retry an unrelated issuance failure', async () => {
      issueOwnerActivation.mockRejectedValue(
        createStoreAuthError(
          StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
        ),
      );

      await expectCode(
        service.issueOwnerActivation(storeSlug),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
      );
      expect(generate).toHaveBeenCalledTimes(1);
      expect(issueOwnerActivation).toHaveBeenCalledTimes(1);
    });

    it('preserves a static owner eligibility conflict', async () => {
      issueOwnerActivation.mockRejectedValue(
        new StoreAuthError(
          StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT,
          `unsafe detail ${rawToken}`,
        ),
      );

      await expectSafeCode(
        service.issueOwnerActivation(storeSlug),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT,
        [rawToken],
      );
    });

    it('fails closed for an unexpected persistence outcome', async () => {
      issueOwnerActivation.mockResolvedValue('UNKNOWN' as never);

      await expectCode(
        service.issueOwnerActivation(storeSlug),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
      );
      expect(generate).toHaveBeenCalledTimes(1);
    });
  });

  describe('activation orchestration', () => {
    it('checks advisory eligibility before password validation and hashes outside tenant access', async () => {
      const events: string[] = [];
      parse.mockImplementation(() => {
        events.push('parse-token');
        return rawToken;
      });
      hashToken.mockImplementation(() => {
        events.push('hash-token');
        return Buffer.from(tokenHash);
      });
      checkOwnerActivationEligibility.mockImplementation(async () => {
        events.push('advisory-check');
        return true;
      });
      normalizeAndValidate.mockImplementation(() => {
        events.push('validate-password');
        return normalizedPassword;
      });
      hashPassword.mockImplementation(async () => {
        events.push('hash-password');
        return passwordHash;
      });
      let persistedInput:
        | { tokenHash: Buffer; passwordHash: string }
        | undefined;
      activateOwner.mockImplementation(async (input) => {
        events.push('final-activation');
        persistedInput = {
          tokenHash: Buffer.from(input.tokenHash),
          passwordHash: input.passwordHash,
        };
        return { activatedAt };
      });
      withResolvedTenant.mockImplementation(async (_slug, operation) => {
        events.push('tenant-access-open');
        const result = await operation({ storeId, tenantAccess });
        events.push('tenant-access-closed');
        return result;
      });

      await expect(
        service.activateOwner(storeSlug, rawToken, password),
      ).resolves.toEqual({ activatedAt });

      expect(events).toEqual([
        'parse-token',
        'hash-token',
        'tenant-access-open',
        'advisory-check',
        'tenant-access-closed',
        'validate-password',
        'hash-password',
        'tenant-access-open',
        'final-activation',
        'tenant-access-closed',
      ]);
      expect(persistedInput).toEqual({ tokenHash, passwordHash });
      expect(hashPassword).toHaveBeenCalledWith(normalizedPassword);
    });

    it('skips password policy and Argon2 when advisory eligibility is false', async () => {
      checkOwnerActivationEligibility.mockResolvedValue(false);

      await expectCode(
        service.activateOwner(storeSlug, rawToken, password),
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      );
      expect(normalizeAndValidate).not.toHaveBeenCalled();
      expect(hashPassword).not.toHaveBeenCalled();
      expect(activateOwner).not.toHaveBeenCalled();
      expect(withResolvedTenant).toHaveBeenCalledTimes(1);
    });

    it('does not trust advisory success after mutable state changes', async () => {
      checkOwnerActivationEligibility.mockResolvedValue(true);
      let persistedInput:
        | { tokenHash: Buffer; passwordHash: string }
        | undefined;
      activateOwner.mockImplementation(async (input) => {
        persistedInput = {
          tokenHash: Buffer.from(input.tokenHash),
          passwordHash: input.passwordHash,
        };
        throw createStoreAuthError(
          StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
        );
      });

      await expectCode(
        service.activateOwner(storeSlug, rawToken, password),
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      );
      expect(hashPassword).toHaveBeenCalledTimes(1);
      expect(persistedInput).toEqual({ tokenHash, passwordHash });
    });

    it('stores an Argon2id hash that verifies against the normalized password', async () => {
      const actualPolicy = new PasswordPolicyService();
      const actualHasher = new PasswordHasherService(actualPolicy);
      const decomposedPassword = 'e\u0301'.repeat(15);
      let capturedHash = '';
      activateOwner.mockImplementation(async (input) => {
        capturedHash = input.passwordHash;
        return { activatedAt };
      });
      service = createService(actualPolicy, actualHasher);

      await service.activateOwner(storeSlug, rawToken, decomposedPassword);

      expect(capturedHash).toMatch(/^\$argon2id\$/);
      await expect(
        actualHasher.verify(capturedHash, decomposedPassword.normalize('NFC')),
      ).resolves.toBe(true);
      expect(capturedHash).not.toContain(decomposedPassword);
    });

    it('maps malformed token format before tenant access or Argon2', async () => {
      parse.mockImplementation(() => {
        throw createStoreAuthError(StoreAuthErrorCode.ACTIVATION_TOKEN_INVALID);
      });

      await expectCode(
        service.activateOwner(storeSlug, 'unsafe-token', password),
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      );
      expect(hashToken).not.toHaveBeenCalled();
      expect(hashPassword).not.toHaveBeenCalled();
      expect(withResolvedTenant).not.toHaveBeenCalled();
    });

    it('checks password policy after a successful advisory read', async () => {
      normalizeAndValidate.mockImplementation(() => {
        throw createStoreAuthError(StoreAuthErrorCode.PASSWORD_POLICY_INVALID);
      });

      await expectCode(
        service.activateOwner(storeSlug, rawToken, 'short'),
        StoreAuthErrorCode.PASSWORD_POLICY_INVALID,
      );
      expect(checkOwnerActivationEligibility).toHaveBeenCalledTimes(1);
      expect(hashPassword).not.toHaveBeenCalled();
      expect(withResolvedTenant).toHaveBeenCalledTimes(1);
    });

    it('returns only the committed timestamp', async () => {
      const result = await service.activateOwner(
        storeSlug,
        rawToken,
        password,
      );

      expect(result).toEqual({ activatedAt });
      expect(Object.keys(result)).toEqual(['activatedAt']);
      expect(result).not.toHaveProperty('tokenHash');
      expect(result).not.toHaveProperty('passwordHash');
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('reconstructs activation failures with static safe messages', async () => {
      activateOwner.mockRejectedValue(
        new StoreAuthError(
          StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
          `unsafe token ${rawToken} password ${passwordHash}`,
        ),
      );

      await expectSafeCode(
        service.activateOwner(storeSlug, rawToken, password),
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
        [rawToken, passwordHash],
      );
    });

    it('maps unknown activation failures to a static persistence failure', async () => {
      activateOwner.mockRejectedValue(
        new Error(`Prisma detail ${rawToken} ${password}`),
      );

      await expectSafeCode(
        service.activateOwner(storeSlug, rawToken, password),
        StoreAuthErrorCode.OWNER_ACTIVATION_FAILED,
        [rawToken, password, 'Prisma detail'],
      );
    });
  });

  function createService(
    policy = { normalizeAndValidate } as unknown as PasswordPolicyService,
    hasher = { hash: hashPassword } as unknown as PasswordHasherService,
  ): StoreOwnerActivationService {
    return new StoreOwnerActivationService(
      { withResolvedTenant } as unknown as StoreTenantAccessService,
      { generate, parse, hash: hashToken } as unknown as ActivationTokenService,
      policy,
      hasher,
      {
        getActivationConfiguration,
      } as unknown as StoreOwnerActivationConfigService,
    );
  }
});

async function expectCode(
  promise: Promise<unknown>,
  code: StoreAuthErrorCode,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected Store Owner activation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
  }
}

async function expectSafeCode(
  promise: Promise<unknown>,
  code: StoreAuthErrorCode,
  forbiddenValues: string[],
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected Store Owner activation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
    for (const value of forbiddenValues) {
      expect((error as Error).message).not.toContain(value);
    }
  }
}
