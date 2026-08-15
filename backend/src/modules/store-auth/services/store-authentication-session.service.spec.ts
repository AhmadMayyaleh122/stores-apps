import {
  createStoreAuthError,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { RefreshTokenService } from './refresh-token.service';
import { StoreAccessTokenService } from './store-access-token.service';
import { StoreAuthSessionConfigService } from './store-auth-session-config.service';
import {
  STORE_AUTH_REFRESH_TOKEN_MAX_ATTEMPTS,
  StoreAuthenticationSessionService,
} from './store-authentication-session.service';
import {
  StoreAuthTenantAccess,
  StoreTenantAccessService,
} from './store-tenant-access.service';

describe('StoreAuthenticationSessionService', () => {
  const storeSlug = 'demo-store';
  const storeId = '12345678-1234-4234-8123-456789012345';
  const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const email = 'owner@example.com';
  const issuedAt = new Date('2026-08-15T12:00:00.000Z');
  const refreshExpiresAt = new Date('2026-09-14T12:00:00.000Z');
  const accessExpiresAt = new Date('2026-08-15T12:15:00.000Z');
  const rawToken = `srt_${Buffer.alloc(32, 7).toString('base64url')}`;
  const tokenHash = Buffer.alloc(32, 11);
  const owner = Object.freeze({ storeId, ownerId, email });
  let withResolvedTenant: jest.Mock;
  let createOwnerRefreshSession: jest.Mock;
  let generate: jest.Mock;
  let issue: jest.Mock;
  let getAuthenticationConfiguration: jest.Mock;
  let tenantAccess: StoreAuthTenantAccess;
  let service: StoreAuthenticationSessionService;

  beforeEach(() => {
    createOwnerRefreshSession = jest.fn().mockResolvedValue({
      sessionId,
      issuedAt,
      expiresAt: refreshExpiresAt,
    });
    tenantAccess = Object.freeze({
      kind: 'STORE_AUTH_TENANT_ACCESS' as const,
      findOwnerLoginCredential: jest.fn(),
      checkOwnerActivationEligibility: jest.fn(),
      issueOwnerActivation: jest.fn(),
      activateOwner: jest.fn(),
      createOwnerRefreshSession,
      rotateOwnerRefreshSession: jest.fn(),
    });
    withResolvedTenant = jest.fn(async (_slug, operation) =>
      operation({ storeId, tenantAccess }),
    );
    generate = jest.fn().mockImplementation(() => ({
      rawToken,
      tokenHash: Buffer.from(tokenHash),
    }));
    issue = jest.fn().mockResolvedValue({
      accessToken: 'signed.access.token',
      expiresAt: accessExpiresAt,
    });
    getAuthenticationConfiguration = jest.fn().mockReturnValue({
      refreshTokenTtlMinutes: 43_200,
    });
    service = createService();
  });

  it('returns only client-safe tokens and expirations', async () => {
    const result = await service.createOwnerAuthenticationState(storeSlug, owner);

    expect(result).toEqual({
      accessToken: 'signed.access.token',
      accessTokenExpiresAt: accessExpiresAt,
      refreshToken: rawToken,
      refreshTokenExpiresAt: refreshExpiresAt,
    });
    expect(Object.keys(result).sort()).toEqual([
      'accessToken',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
    ]);
    expect(result).not.toHaveProperty('sessionId');
    expect(result).not.toHaveProperty('refreshTokenHash');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('passes only owner ID, hash, and bounded TTL into tenant persistence', async () => {
    let capturedInput: Record<string, unknown> | undefined;
    createOwnerRefreshSession.mockImplementation(async (input) => {
      capturedInput = {
        ...input,
        refreshTokenHash: Buffer.from(input.refreshTokenHash),
      };
      return { sessionId, issuedAt, expiresAt: refreshExpiresAt };
    });

    await service.createOwnerAuthenticationState(storeSlug, owner);

    expect(capturedInput).toEqual({ ownerId, refreshTokenHash: tokenHash, ttlMinutes: 43_200 });
    expect(Object.keys(capturedInput as object).sort()).toEqual([
      'ownerId',
      'refreshTokenHash',
      'ttlMinutes',
    ]);
    expect(capturedInput).not.toHaveProperty('rawToken');
    expect(capturedInput).not.toHaveProperty('issuedAt');
    expect(capturedInput).not.toHaveProperty('expiresAt');
    expect(issue).toHaveBeenCalledWith({ ownerId, storeId, sessionId, issuedAt });
  });

  it('zeros the orchestration hash buffer after persistence', async () => {
    const generatedHash = Buffer.from(tokenHash);
    generate.mockReturnValue({ rawToken, tokenHash: generatedHash });

    await service.createOwnerAuthenticationState(storeSlug, owner);

    expect(generatedHash).toEqual(Buffer.alloc(32));
  });

  it('regenerates after an exact refresh-hash collision', async () => {
    const secondRawToken = `srt_${Buffer.alloc(32, 8).toString('base64url')}`;
    const secondHash = Buffer.alloc(32, 12);
    generate
      .mockReturnValueOnce({ rawToken, tokenHash: Buffer.from(tokenHash) })
      .mockReturnValueOnce({ rawToken: secondRawToken, tokenHash: Buffer.from(secondHash) });
    createOwnerRefreshSession
      .mockResolvedValueOnce('REFRESH_TOKEN_HASH_COLLISION')
      .mockResolvedValueOnce({ sessionId, issuedAt, expiresAt: refreshExpiresAt });

    await expect(
      service.createOwnerAuthenticationState(storeSlug, owner),
    ).resolves.toMatchObject({ refreshToken: secondRawToken });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(createOwnerRefreshSession).toHaveBeenCalledTimes(2);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('limits exact hash-collision retries', async () => {
    createOwnerRefreshSession.mockResolvedValue('REFRESH_TOKEN_HASH_COLLISION');

    await expectCode(
      service.createOwnerAuthenticationState(storeSlug, owner),
      StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
    );
    expect(generate).toHaveBeenCalledTimes(STORE_AUTH_REFRESH_TOKEN_MAX_ATTEMPTS);
    expect(issue).not.toHaveBeenCalled();
  });

  it('rejects a resolved tenant that does not match the authenticated store', async () => {
    withResolvedTenant.mockImplementation(async (_slug, operation) =>
      operation({
        storeId: '87654321-4321-4321-8123-456789012345',
        tenantAccess,
      }),
    );

    await expectCode(
      service.createOwnerAuthenticationState(storeSlug, owner),
      StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
    );
    expect(createOwnerRefreshSession).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [{ ...owner, ownerId: 'not-a-uuid' }],
    [{ ...owner, storeId: 'not-a-uuid' }],
    [{ ...owner, email: ' OWNER@example.com ' }],
  ])('rejects a noncanonical authenticated owner %#', async (candidate) => {
    await expectCode(
      service.createOwnerAuthenticationState(storeSlug, candidate as never),
      StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
    );
    expect(withResolvedTenant).not.toHaveBeenCalled();
  });

  it('preserves an ACTIVE-state revalidation failure without issuing a JWT', async () => {
    createOwnerRefreshSession.mockRejectedValue(
      new StoreAuthError(
        StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
        `unsafe database detail ${rawToken}`,
      ),
    );

    await expectCode(
      service.createOwnerAuthenticationState(storeSlug, owner),
      StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
      rawToken,
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it('sanitizes persistence and signing failures without returning the raw token', async () => {
    createOwnerRefreshSession.mockRejectedValueOnce(
      new Error(`Prisma detail ${rawToken}`),
    );
    await expectCode(
      service.createOwnerAuthenticationState(storeSlug, owner),
      StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
      rawToken,
    );

    createOwnerRefreshSession.mockResolvedValueOnce({ sessionId, issuedAt, expiresAt: refreshExpiresAt });
    issue.mockRejectedValueOnce(new Error(`signer detail ${rawToken}`));
    await expectCode(
      service.createOwnerAuthenticationState(storeSlug, owner),
      StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
      rawToken,
    );
  });

  it('preserves dedicated safe dependency errors with their static messages', async () => {
    generate.mockImplementation(() => {
      throw createStoreAuthError(StoreAuthErrorCode.REFRESH_TOKEN_GENERATION_FAILED);
    });

    await expectCode(
      service.createOwnerAuthenticationState(storeSlug, owner),
      StoreAuthErrorCode.REFRESH_TOKEN_GENERATION_FAILED,
    );
  });

  function createService(): StoreAuthenticationSessionService {
    return new StoreAuthenticationSessionService(
      { withResolvedTenant } as unknown as StoreTenantAccessService,
      { generate } as unknown as RefreshTokenService,
      { issue } as unknown as StoreAccessTokenService,
      { getAuthenticationConfiguration } as unknown as StoreAuthSessionConfigService,
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
    throw new Error('Expected session creation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
    if (forbiddenValue) expect((error as Error).message).not.toContain(forbiddenValue);
  }
}
