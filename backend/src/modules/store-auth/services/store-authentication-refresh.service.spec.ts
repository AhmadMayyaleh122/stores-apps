import {
  createStoreAuthError,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { RefreshTokenService } from './refresh-token.service';
import { StoreAccessTokenService } from './store-access-token.service';
import {
  STORE_AUTH_REFRESH_ROTATION_MAX_ATTEMPTS,
  StoreAuthenticationRefreshService,
} from './store-authentication-refresh.service';
import { StoreAuthSessionConfigService } from './store-auth-session-config.service';
import {
  StoreAuthTenantAccess,
  StoreTenantAccessService,
} from './store-tenant-access.service';

describe('StoreAuthenticationRefreshService', () => {
  const storeSlug = 'demo-store';
  const storeId = '12345678-1234-4234-8123-456789012345';
  const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const refreshTime = new Date('2026-08-15T12:00:00.000Z');
  const refreshExpiresAt = new Date('2026-09-14T12:00:00.000Z');
  const accessExpiresAt = new Date('2026-08-15T12:15:00.000Z');
  const rawToken = `srt_${Buffer.alloc(32, 7).toString('base64url')}`;
  const replacementRawToken = `srt_${Buffer.alloc(32, 8).toString('base64url')}`;
  const presentedHash = Buffer.alloc(32, 11);
  const replacementHash = Buffer.alloc(32, 12);
  let withResolvedTenant: jest.Mock;
  let rotateOwnerRefreshSession: jest.Mock;
  let hash: jest.Mock;
  let generate: jest.Mock;
  let issue: jest.Mock;
  let getAuthenticationConfiguration: jest.Mock;
  let tenantAccess: StoreAuthTenantAccess;
  let service: StoreAuthenticationRefreshService;

  beforeEach(() => {
    issue = jest.fn().mockResolvedValue({
      accessToken: 'signed.access.token',
      expiresAt: accessExpiresAt,
    });
    rotateOwnerRefreshSession = jest.fn(async (_input, issuer) => {
      const accessToken = await issuer({
        ownerId,
        storeId,
        sessionId,
        issuedAt: refreshTime,
      });
      return {
        accessToken: accessToken.accessToken,
        accessTokenExpiresAt: accessToken.expiresAt,
        refreshTokenExpiresAt: refreshExpiresAt,
      };
    });
    tenantAccess = Object.freeze({
      kind: 'STORE_AUTH_TENANT_ACCESS' as const,
      findOwnerLoginCredential: jest.fn(),
      checkOwnerActivationEligibility: jest.fn(),
      issueOwnerActivation: jest.fn(),
      activateOwner: jest.fn(),
      createOwnerRefreshSession: jest.fn(),
      rotateOwnerRefreshSession,
      revokeOwnerRefreshSession: jest.fn(),
    });
    withResolvedTenant = jest.fn(async (_slug, operation) =>
      operation({ storeId, tenantAccess }),
    );
    hash = jest.fn().mockReturnValue(Buffer.from(presentedHash));
    generate = jest.fn().mockReturnValue({
      rawToken: replacementRawToken,
      tokenHash: Buffer.from(replacementHash),
    });
    getAuthenticationConfiguration = jest.fn().mockReturnValue({
      refreshTokenTtlMinutes: 43_200,
    });
    service = createService();
  });

  it('returns only the replacement tokens and their expirations', async () => {
    const result = await service.refreshOwnerAuthenticationState(
      storeSlug,
      rawToken,
    );

    expect(result).toEqual({
      accessToken: 'signed.access.token',
      accessTokenExpiresAt: accessExpiresAt,
      refreshToken: replacementRawToken,
      refreshTokenExpiresAt: refreshExpiresAt,
    });
    expect(Object.keys(result).sort()).toEqual([
      'accessToken',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
    ]);
    expect(result).not.toHaveProperty('sessionId');
    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('refreshTokenHash');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('passes only digests and the validated TTL to tenant persistence', async () => {
    let capturedInput: Record<string, unknown> | undefined;
    rotateOwnerRefreshSession.mockImplementation(async (input, issuer) => {
      capturedInput = {
        ...input,
        presentedRefreshTokenHash: Buffer.from(
          input.presentedRefreshTokenHash,
        ),
        replacementRefreshTokenHash: Buffer.from(
          input.replacementRefreshTokenHash,
        ),
      };
      const accessToken = await issuer({
        ownerId,
        storeId,
        sessionId,
        issuedAt: refreshTime,
      });
      return {
        accessToken: accessToken.accessToken,
        accessTokenExpiresAt: accessToken.expiresAt,
        refreshTokenExpiresAt: refreshExpiresAt,
      };
    });

    await service.refreshOwnerAuthenticationState(storeSlug, rawToken);

    expect(capturedInput).toEqual({
      presentedRefreshTokenHash: presentedHash,
      replacementRefreshTokenHash: replacementHash,
      ttlMinutes: 43_200,
    });
    expect(capturedInput).not.toHaveProperty('rawRefreshToken');
    expect(capturedInput).not.toHaveProperty('ownerId');
    expect(capturedInput).not.toHaveProperty('sessionId');
    expect(issue).toHaveBeenCalledWith({
      ownerId,
      storeId,
      sessionId,
      issuedAt: refreshTime,
    });
  });

  it('resolves the tenant before parsing and hashing the presented token', async () => {
    const events: string[] = [];
    withResolvedTenant.mockImplementation(async (_slug, operation) => {
      events.push('resolve-tenant');
      return operation({ storeId, tenantAccess });
    });
    hash.mockImplementation(() => {
      events.push('hash-token');
      return Buffer.from(presentedHash);
    });

    await service.refreshOwnerAuthenticationState(storeSlug, rawToken);

    expect(events.slice(0, 2)).toEqual(['resolve-tenant', 'hash-token']);
  });

  it('never passes either raw refresh token into tenant persistence', async () => {
    rotateOwnerRefreshSession.mockImplementation(async (input) => {
      expect(JSON.stringify(input)).not.toContain(rawToken);
      expect(JSON.stringify(input)).not.toContain(replacementRawToken);
      return 'INVALID_REFRESH';
    });

    await expectCode(
      service.refreshOwnerAuthenticationState(storeSlug, rawToken),
      StoreAuthErrorCode.AUTH_REFRESH_INVALID,
      rawToken,
    );
  });

  it.each(['INVALID_REFRESH', 'INVALID_REFRESH_REVOKED'] as const)(
    'maps %s to one stable invalid-refresh error',
    async (outcome) => {
      rotateOwnerRefreshSession.mockResolvedValue(outcome);

      await expectCode(
        service.refreshOwnerAuthenticationState(storeSlug, rawToken),
        StoreAuthErrorCode.AUTH_REFRESH_INVALID,
        rawToken,
      );
      expect(issue).not.toHaveBeenCalled();
    },
  );

  it('maps malformed refresh tokens to the stable invalid-refresh error', async () => {
    hash.mockImplementation(() => {
      throw createStoreAuthError(StoreAuthErrorCode.REFRESH_TOKEN_INVALID);
    });

    await expectCode(
      service.refreshOwnerAuthenticationState(storeSlug, 'malformed'),
      StoreAuthErrorCode.AUTH_REFRESH_INVALID,
      'malformed',
    );
    expect(generate).not.toHaveBeenCalled();
    expect(rotateOwnerRefreshSession).not.toHaveBeenCalled();
  });

  it('retries only replacement-hash collisions and returns the successful token', async () => {
    const secondRawToken = `srt_${Buffer.alloc(32, 9).toString('base64url')}`;
    const secondHash = Buffer.alloc(32, 13);
    generate
      .mockReturnValueOnce({
        rawToken: replacementRawToken,
        tokenHash: Buffer.from(replacementHash),
      })
      .mockReturnValueOnce({
        rawToken: secondRawToken,
        tokenHash: Buffer.from(secondHash),
      });
    rotateOwnerRefreshSession
      .mockResolvedValueOnce('REFRESH_TOKEN_HASH_COLLISION')
      .mockImplementationOnce(async (_input, issuer) => {
        const accessToken = await issuer({
          ownerId,
          storeId,
          sessionId,
          issuedAt: refreshTime,
        });
        return {
          accessToken: accessToken.accessToken,
          accessTokenExpiresAt: accessToken.expiresAt,
          refreshTokenExpiresAt: refreshExpiresAt,
        };
      });

    await expect(
      service.refreshOwnerAuthenticationState(storeSlug, rawToken),
    ).resolves.toMatchObject({ refreshToken: secondRawToken });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(rotateOwnerRefreshSession).toHaveBeenCalledTimes(2);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('regenerates rather than accepting replacement material equal to the presented digest', async () => {
    generate
      .mockReturnValueOnce({
        rawToken,
        tokenHash: Buffer.from(presentedHash),
      })
      .mockReturnValueOnce({
        rawToken: replacementRawToken,
        tokenHash: Buffer.from(replacementHash),
      });

    await service.refreshOwnerAuthenticationState(storeSlug, rawToken);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(rotateOwnerRefreshSession).toHaveBeenCalledTimes(1);
  });

  it('bounds collision retries and never issues an access token', async () => {
    rotateOwnerRefreshSession.mockResolvedValue(
      'REFRESH_TOKEN_HASH_COLLISION',
    );

    await expectCode(
      service.refreshOwnerAuthenticationState(storeSlug, rawToken),
      StoreAuthErrorCode.AUTH_REFRESH_FAILED,
    );
    expect(generate).toHaveBeenCalledTimes(
      STORE_AUTH_REFRESH_ROTATION_MAX_ATTEMPTS,
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it('zeros presented and replacement digest buffers after success', async () => {
    const presented = Buffer.from(presentedHash);
    const replacement = Buffer.from(replacementHash);
    hash.mockReturnValue(presented);
    generate.mockReturnValue({
      rawToken: replacementRawToken,
      tokenHash: replacement,
    });

    await service.refreshOwnerAuthenticationState(storeSlug, rawToken);

    expect(presented).toEqual(Buffer.alloc(32));
    expect(replacement).toEqual(Buffer.alloc(32));
  });

  it('sanitizes persistence and signing failures without token leakage', async () => {
    rotateOwnerRefreshSession.mockRejectedValueOnce(
      new Error(`database detail ${rawToken}`),
    );
    await expectCode(
      service.refreshOwnerAuthenticationState(storeSlug, rawToken),
      StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      rawToken,
    );

    rotateOwnerRefreshSession.mockImplementationOnce(async (_input, issuer) =>
      issuer({ ownerId, storeId, sessionId, issuedAt: refreshTime }),
    );
    issue.mockRejectedValueOnce(new Error(`signer detail ${rawToken}`));
    await expectCode(
      service.refreshOwnerAuthenticationState(storeSlug, rawToken),
      StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      rawToken,
    );
  });

  it('preserves safe tenant resolution and operational dependency errors', async () => {
    for (const code of [
      StoreAuthErrorCode.STORE_SLUG_INVALID,
      StoreAuthErrorCode.TENANT_UNAVAILABLE,
      StoreAuthErrorCode.TENANT_IDENTITY_INVALID,
      StoreAuthErrorCode.TENANT_ACCESS_FAILED,
      StoreAuthErrorCode.TENANT_CLEANUP_FAILED,
      StoreAuthErrorCode.REFRESH_TOKEN_HASHING_FAILED,
      StoreAuthErrorCode.REFRESH_TOKEN_GENERATION_FAILED,
      StoreAuthErrorCode.AUTHENTICATION_CONFIGURATION_INVALID,
    ]) {
      withResolvedTenant.mockRejectedValueOnce(createStoreAuthError(code));
      await expectCode(
        service.refreshOwnerAuthenticationState(storeSlug, rawToken),
        code,
      );
    }
  });

  function createService(): StoreAuthenticationRefreshService {
    return new StoreAuthenticationRefreshService(
      { withResolvedTenant } as unknown as StoreTenantAccessService,
      { hash, generate } as unknown as RefreshTokenService,
      { issue } as unknown as StoreAccessTokenService,
      {
        getAuthenticationConfiguration,
      } as unknown as StoreAuthSessionConfigService,
    );
  }
});

async function expectCode(
  promise: Promise<unknown>,
  code: StoreAuthErrorCode,
  forbiddenValue?: string,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected refresh to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
    if (forbiddenValue) {
      expect((error as Error).message).not.toContain(forbiddenValue);
    }
  }
}
