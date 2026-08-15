import {
  createStoreAuthError,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { PasswordHasherService } from './password-hasher.service';
import { StoreOwnerLoginService } from './store-owner-login.service';
import {
  OwnerLoginCredential,
  StoreAuthTenantAccess,
  StoreTenantAccessService,
} from './store-tenant-access.service';

describe('StoreOwnerLoginService', () => {
  const storeId = '12345678-1234-4234-8123-456789012345';
  const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const storeSlug = 'demo-store';
  const email = 'owner@example.com';
  const password = 'correct horse battery staple';
  const passwordHash =
    '$argon2id$v=19$m=65536,t=3,p=1$kvWU+X2SSp6Z5790fw8zug$npylD8PtUEAIn7XhZURLQTnScHcPENwRkCf3WTqy1FI';
  let service: StoreOwnerLoginService;
  let withResolvedTenant: jest.Mock;
  let findOwnerLoginCredential: jest.Mock;
  let verifyWithDummy: jest.Mock;
  let tenantAccess: StoreAuthTenantAccess;
  let candidate: OwnerLoginCredential;

  beforeEach(() => {
    candidate = Object.freeze({ ownerId, email, passwordHash });
    findOwnerLoginCredential = jest.fn().mockResolvedValue(candidate);
    tenantAccess = Object.freeze({
      kind: 'STORE_AUTH_TENANT_ACCESS' as const,
      findOwnerLoginCredential,
      checkOwnerActivationEligibility: jest.fn(),
      issueOwnerActivation: jest.fn(),
      activateOwner: jest.fn(),
      createOwnerRefreshSession: jest.fn(),
    });
    withResolvedTenant = jest.fn(async (_slug, operation) =>
      operation({ storeId, tenantAccess }),
    );
    verifyWithDummy = jest.fn().mockResolvedValue(true);
    service = new StoreOwnerLoginService(
      { withResolvedTenant } as unknown as StoreTenantAccessService,
      { verifyWithDummy } as unknown as PasswordHasherService,
    );
  });

  it('returns only the minimum frozen authenticated-owner identity', async () => {
    const result = await service.authenticateOwner(
      storeSlug,
      email,
      password,
    );

    expect(result).toEqual({ storeId, ownerId, email });
    expect(Object.keys(result).sort()).toEqual([
      'email',
      'ownerId',
      'storeId',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(passwordHash);
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('tenantDatabaseUrl');
  });

  it('canonicalizes email exactly once before tenant lookup', async () => {
    await service.authenticateOwner(
      storeSlug,
      '  OWNER@Example.COM  ',
      password,
    );

    expect(withResolvedTenant).toHaveBeenCalledWith(
      storeSlug,
      expect.any(Function),
    );
    expect(findOwnerLoginCredential).toHaveBeenCalledWith({ email });
  });

  it('passes only the stored hash and plaintext input to the password verifier', async () => {
    await service.authenticateOwner(storeSlug, email, password);

    expect(verifyWithDummy).toHaveBeenCalledWith(passwordHash, password);
    expect(findOwnerLoginCredential).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong password with the stable invalid-credentials error', async () => {
    verifyWithDummy.mockResolvedValue(false);

    await expectInvalidCredentials(
      service.authenticateOwner(storeSlug, email, password),
    );
  });

  it.each(['unknown email', 'missing credential', 'ineligible owner'])(
    'uses dummy verification and the same failure for %s',
    async () => {
      findOwnerLoginCredential.mockResolvedValue(null);

      await expectInvalidCredentials(
        service.authenticateOwner(storeSlug, email, password),
      );
      expect(verifyWithDummy).toHaveBeenCalledWith(undefined, password);
    },
  );

  it.each([
    null,
    '',
    '   ',
    'not-an-email',
    `${'a'.repeat(250)}@example.com`,
  ])('rejects malformed email input %p before tenant access', async (value) => {
    await expectInvalidCredentials(
      service.authenticateOwner(storeSlug, value, password),
    );
    expect(withResolvedTenant).not.toHaveBeenCalled();
    expect(verifyWithDummy).not.toHaveBeenCalled();
  });

  it.each([null, 42, 'too-short'])(
    'fails safely when the password verifier rejects malformed input %p',
    async (value) => {
      verifyWithDummy.mockResolvedValue(false);

      await expectInvalidCredentials(
        service.authenticateOwner(storeSlug, email, value),
      );
      expect(verifyWithDummy).toHaveBeenCalledWith(passwordHash, value);
    },
  );

  it('reconstructs unsafe credential errors without sensitive details', async () => {
    findOwnerLoginCredential.mockRejectedValue(
      new StoreAuthError(
        StoreAuthErrorCode.INVALID_STORE_CREDENTIALS,
        `unsafe ${email} ${password} ${passwordHash}`,
      ),
    );

    try {
      await service.authenticateOwner(storeSlug, email, password);
      throw new Error('Expected Store Owner login to fail');
    } catch (error) {
      expect(error).toEqual(
        expect.objectContaining({
          code: StoreAuthErrorCode.INVALID_STORE_CREDENTIALS,
          message: 'Store credentials are invalid.',
        }),
      );
      expect((error as Error).message).not.toContain(email);
      expect((error as Error).message).not.toContain(password);
      expect((error as Error).message).not.toContain(passwordHash);
    }
  });

  it.each([
    StoreAuthErrorCode.TENANT_IDENTITY_INVALID,
    StoreAuthErrorCode.TENANT_CLEANUP_FAILED,
    StoreAuthErrorCode.TENANT_UNAVAILABLE,
  ])('preserves the safe tenant boundary error %s', async (code) => {
    withResolvedTenant.mockRejectedValue(createStoreAuthError(code));

    try {
      await service.authenticateOwner(storeSlug, email, password);
      throw new Error('Expected Store Owner login to fail');
    } catch (error) {
      expect(error).toEqual(
        expect.objectContaining({
          code,
          message: createStoreAuthError(code).message,
        }),
      );
    }
  });

  it('maps unexpected failures to invalid credentials without leaking inputs', async () => {
    withResolvedTenant.mockRejectedValue(
      new Error(`unexpected ${email} ${password}`),
    );

    await expectInvalidCredentials(
      service.authenticateOwner(storeSlug, email, password),
    );
  });
});

async function expectInvalidCredentials(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error('Expected Store Owner login to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect(error).toEqual(
      expect.objectContaining({
        code: StoreAuthErrorCode.INVALID_STORE_CREDENTIALS,
        message: 'Store credentials are invalid.',
      }),
    );
  }
}
