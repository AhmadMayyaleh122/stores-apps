import {
  createStoreAuthError,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { RefreshTokenService } from './refresh-token.service';
import { StoreAuthenticationLogoutService } from './store-authentication-logout.service';
import {
  StoreAuthTenantAccess,
  StoreTenantAccessService,
} from './store-tenant-access.service';

describe('StoreAuthenticationLogoutService', () => {
  const storeSlug = 'demo-store';
  const storeId = '12345678-1234-4234-8123-456789012345';
  const rawToken = `srt_${Buffer.alloc(32, 7).toString('base64url')}`;
  const tokenHash = Buffer.alloc(32, 11);
  let withResolvedTenant: jest.Mock;
  let revokeOwnerRefreshSession: jest.Mock;
  let hash: jest.Mock;
  let tenantAccess: StoreAuthTenantAccess;
  let service: StoreAuthenticationLogoutService;

  beforeEach(() => {
    revokeOwnerRefreshSession = jest.fn().mockResolvedValue('REVOKED');
    tenantAccess = Object.freeze({
      kind: 'STORE_AUTH_TENANT_ACCESS' as const,
      findOwnerLoginCredential: jest.fn(),
      checkOwnerActivationEligibility: jest.fn(),
      issueOwnerActivation: jest.fn(),
      activateOwner: jest.fn(),
      createOwnerRefreshSession: jest.fn(),
      rotateOwnerRefreshSession: jest.fn(),
      revokeOwnerRefreshSession,
    });
    withResolvedTenant = jest.fn(async (_slug, operation) =>
      operation({ storeId, tenantAccess }),
    );
    hash = jest.fn().mockReturnValue(Buffer.from(tokenHash));
    service = new StoreAuthenticationLogoutService(
      { withResolvedTenant } as unknown as StoreTenantAccessService,
      { hash } as unknown as RefreshTokenService,
    );
  });

  it.each(['REVOKED', 'NO_REVOCABLE_SESSION'] as const)(
    'returns no session state for the %s persistence outcome',
    async (outcome) => {
      revokeOwnerRefreshSession.mockResolvedValue(outcome);

      await expect(
        service.logoutOwnerSession(storeSlug, rawToken),
      ).resolves.toBeUndefined();
      expect(revokeOwnerRefreshSession).toHaveBeenCalledTimes(1);
    },
  );

  it('resolves the tenant before hashing and passes only the digest to persistence', async () => {
    const events: string[] = [];
    let capturedInput: Record<string, unknown> | undefined;
    withResolvedTenant.mockImplementation(async (_slug, operation) => {
      events.push('resolve-tenant');
      return operation({ storeId, tenantAccess });
    });
    hash.mockImplementation(() => {
      events.push('hash-token');
      return Buffer.from(tokenHash);
    });
    revokeOwnerRefreshSession.mockImplementation(async (input) => {
      events.push('revoke-session');
      capturedInput = {
        refreshTokenHash: Buffer.from(input.refreshTokenHash),
      };
      return 'REVOKED';
    });

    await service.logoutOwnerSession(storeSlug, rawToken);

    expect(events).toEqual([
      'resolve-tenant',
      'hash-token',
      'revoke-session',
    ]);
    expect(capturedInput).toEqual({ refreshTokenHash: tokenHash });
    expect(capturedInput).not.toHaveProperty('rawRefreshToken');
    expect(capturedInput).not.toHaveProperty('storeSlug');
    expect(JSON.stringify(capturedInput)).not.toContain(rawToken);
  });

  it('treats malformed tokens as a successful no-op after tenant resolution', async () => {
    hash.mockImplementation(() => {
      throw createStoreAuthError(StoreAuthErrorCode.REFRESH_TOKEN_INVALID);
    });

    await expect(
      service.logoutOwnerSession(storeSlug, 'malformed'),
    ).resolves.toBeUndefined();
    expect(withResolvedTenant).toHaveBeenCalledWith(
      storeSlug,
      expect.any(Function),
    );
    expect(revokeOwnerRefreshSession).not.toHaveBeenCalled();
  });

  it.each([
    StoreAuthErrorCode.STORE_SLUG_INVALID,
    StoreAuthErrorCode.TENANT_UNAVAILABLE,
    StoreAuthErrorCode.TENANT_IDENTITY_INVALID,
    StoreAuthErrorCode.TENANT_CLEANUP_FAILED,
    StoreAuthErrorCode.REFRESH_TOKEN_HASHING_FAILED,
    StoreAuthErrorCode.AUTH_LOGOUT_FAILED,
  ])('preserves the safe operational error %s', async (code) => {
    if (code === StoreAuthErrorCode.REFRESH_TOKEN_HASHING_FAILED) {
      hash.mockImplementation(() => {
        throw createStoreAuthError(code);
      });
    } else if (code === StoreAuthErrorCode.AUTH_LOGOUT_FAILED) {
      revokeOwnerRefreshSession.mockRejectedValue(
        createStoreAuthError(code),
      );
    } else {
      withResolvedTenant.mockRejectedValue(createStoreAuthError(code));
    }

    await expectCode(
      service.logoutOwnerSession(storeSlug, rawToken),
      code,
      rawToken,
    );
  });

  it('sanitizes unexpected persistence failures without leaking the raw token', async () => {
    revokeOwnerRefreshSession.mockRejectedValue(
      new Error(`database detail containing ${rawToken}`),
    );

    await expectCode(
      service.logoutOwnerSession(storeSlug, rawToken),
      StoreAuthErrorCode.AUTH_LOGOUT_FAILED,
      rawToken,
    );
  });

  it.each(['success', 'failure'] as const)(
    'clears application digest material after %s',
    async (outcome) => {
      const hashBuffer = Buffer.from(tokenHash);
      hash.mockReturnValue(hashBuffer);

      if (outcome === 'failure') {
        revokeOwnerRefreshSession.mockRejectedValue(
          new Error('persistence failed'),
        );
        await expect(
          service.logoutOwnerSession(storeSlug, rawToken),
        ).rejects.toBeInstanceOf(StoreAuthError);
      } else {
        await service.logoutOwnerSession(storeSlug, rawToken);
      }

      expect(hashBuffer).toEqual(Buffer.alloc(32));
    },
  );
});

async function expectCode(
  promise: Promise<unknown>,
  code: StoreAuthErrorCode,
  sensitiveValue: string,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected logout to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
    expect((error as Error).message).not.toContain(sensitiveValue);
  }
}
