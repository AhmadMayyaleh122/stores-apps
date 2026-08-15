import { PrismaPg } from '@prisma/adapter-pg';

import { TenantProvisioningStatus } from '../../../../generated/prisma/client';
import {
  EmployeeStatus,
  PrismaClient as TenantPrismaClient,
} from '../../../../generated/tenant-prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { TenantCredentialEncryptionService } from '../../tenant-provisioning/services/tenant-credential-encryption.service';
import {
  TenantProvisioningConfigService,
  TenantProvisioningEncryptionKey,
} from '../../tenant-provisioning/services/tenant-provisioning-config.service';
import { StoreAuthError, StoreAuthErrorCode } from '../store-auth.errors';
import {
  StoreAuthTenantAccess,
  StoreTenantAccessService,
} from './store-tenant-access.service';

jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: jest.fn() }));
jest.mock('../../../../generated/tenant-prisma/client', () => {
  const actual = jest.requireActual(
    '../../../../generated/tenant-prisma/client',
  );

  return { ...actual, PrismaClient: jest.fn() };
});

describe('StoreTenantAccessService activation transactions', () => {
  const storeId = '12345678-1234-4234-8123-456789012345';
  const otherStoreId = '87654321-4321-4321-8123-456789012345';
  const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const roleId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const tenantDatabaseId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const issuedAt = new Date('2026-08-10T12:00:00.000Z');
  const expiresAt = new Date('2026-08-11T12:00:00.000Z');
  const tokenHash = Buffer.alloc(32, 21);
  const secondTokenHash = Buffer.alloc(32, 22);
  const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test$hash';
  let harness: TransactionHarness;

  beforeEach(() => {
    (PrismaPg as unknown as jest.Mock).mockReset().mockReturnValue({
      adapter: true,
    });
    (TenantPrismaClient as unknown as jest.Mock).mockReset();
    harness = createTransactionHarness();
    (TenantPrismaClient as unknown as jest.Mock).mockReturnValue(
      harness.client,
    );
  });

  describe('issuance and reissue transaction', () => {
    it('locks and revalidates the owner before creating one outstanding token', async () => {
      await expect(issue(tokenHash)).resolves.toBe('ISSUED');

      expect(harness.state.tokens).toHaveLength(1);
      expect(harness.state.tokens[0]).toMatchObject({
        employeeId: ownerId,
        expiresAt,
        createdAt: issuedAt,
        consumedAt: null,
        revokedAt: null,
      });
      expect(harness.state.tokens[0].tokenHash).toEqual(tokenHash);
      expect(harness.events.slice(0, 4)).toEqual([
        'lock-owner',
        'verify-identity',
        'read-owner',
        'read-clock',
      ]);
      expect(harness.lockQueryText).toContain('FOR UPDATE');
      expect(harness.lockQueryValues).toEqual([]);
    });

    it('bases issuance expiry on fresh database time obtained after the owner lock', async () => {
      const postLockTime = new Date('2026-08-12T09:30:00.000Z');
      harness.hooks.transactionClockTime = postLockTime;

      await issue(tokenHash);

      expect(harness.events.indexOf('lock-owner')).toBeLessThan(
        harness.events.indexOf('read-clock'),
      );
      expect(harness.state.tokens[0].createdAt).toEqual(postLockTime);
      expect(harness.state.tokens[0].expiresAt).toEqual(
        new Date('2026-08-13T09:30:00.000Z'),
      );
      expect(
        harness.state.tokens[0].expiresAt.getTime() > postLockTime.getTime(),
      ).toBe(true);
    });

    it('revokes expired and unexpired outstanding tokens while preserving history', async () => {
      harness.state.tokens.push(
        tokenRecord(Buffer.alloc(32, 1), {
          expiresAt: new Date('2026-08-09T00:00:00.000Z'),
        }),
        tokenRecord(Buffer.alloc(32, 2), {
          consumedAt: new Date('2026-08-09T01:00:00.000Z'),
        }),
        tokenRecord(Buffer.alloc(32, 3), {
          revokedAt: new Date('2026-08-09T02:00:00.000Z'),
        }),
      );

      await issue(tokenHash);

      expect(harness.state.tokens[0].revokedAt).toEqual(issuedAt);
      expect(harness.state.tokens[1].consumedAt).toEqual(
        new Date('2026-08-09T01:00:00.000Z'),
      );
      expect(harness.state.tokens[1].revokedAt).toBeNull();
      expect(harness.state.tokens[2].revokedAt).toEqual(
        new Date('2026-08-09T02:00:00.000Z'),
      );
      expect(harness.state.tokens[3].revokedAt).toBeNull();
    });

    it.each([
      EmployeeStatus.ACTIVE,
      EmployeeStatus.INACTIVE,
      EmployeeStatus.SUSPENDED,
    ])('rejects owner status %s', async (status) => {
      harness.state.owner.status = status;

      await expectCode(
        issue(tokenHash),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT,
      );
      expect(harness.state.tokens).toEqual([]);
    });

    it('rejects a missing designated owner', async () => {
      harness.state.owner.isStoreOwner = false;

      await expectCode(
        issue(tokenHash),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT,
      );
    });

    it('rejects invalid issuance values and fails closed on arithmetic overflow', async () => {
      await expectCode(
        harness.service.withResolvedTenant('demo-store', ({ tenantAccess }) =>
          tenantAccess.issueOwnerActivation({
            tokenHash: Buffer.alloc(31),
            ttlMinutes: 1_440,
          }),
        ),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
      );
      expect(harness.events).toEqual([]);

      await expectCode(
        harness.service.withResolvedTenant('demo-store', ({ tenantAccess }) =>
          tenantAccess.issueOwnerActivation({
            tokenHash,
            ttlMinutes: 0,
          }),
        ),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
      );
      await expectCode(
        harness.service.withResolvedTenant('demo-store', ({ tenantAccess }) =>
          tenantAccess.issueOwnerActivation({
            tokenHash,
            ttlMinutes: Number.MAX_SAFE_INTEGER,
          }),
        ),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
      );
      expect(harness.events).toEqual([
        'lock-owner',
        'verify-identity',
        'read-owner',
        'read-clock',
      ]);
      expect(harness.state.tokens).toEqual([]);
    });

    it.each([
      ['credential', () => (harness.state.credential = passwordHash)],
      ['role key', () => (harness.state.owner.role.key = 'MANAGER')],
      ['role name', () => (harness.state.owner.role.name = 'Store Owner')],
      ['system role', () => (harness.state.owner.role.isSystem = false)],
      ['store relationship', () => (harness.state.owner.masterStoreId = otherStoreId)],
      ['tenant identity', () => (harness.state.identityStoreId = otherStoreId)],
    ])('rejects invalid owner %s invariant', async (_label, mutate) => {
      mutate();

      await expectCode(
        issue(tokenHash),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT,
      );
      expect(harness.state.tokens).toEqual([]);
    });

    it('returns only the exact token-hash collision outcome and rolls back revocation', async () => {
      harness.state.tokens.push(tokenRecord(tokenHash));

      await expect(issue(tokenHash)).resolves.toBe('TOKEN_HASH_COLLISION');
      expect(harness.state.tokens).toHaveLength(1);
      expect(harness.state.tokens[0].revokedAt).toBeNull();
    });

    it('does not classify the outstanding-token unique fence as a hash collision', async () => {
      harness.hooks.tokenCreateError = {
        code: 'P2002',
        meta: {
          modelName: 'EmployeeActivationToken',
          driverAdapterError: {
            cause: {
              kind: 'UniqueConstraintViolation',
              constraint: { fields: ['employee_id'] },
            },
          },
        },
      };

      await expectCode(
        issue(tokenHash),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
      );
    });

    it.each([
      [
        'unrelated adapter field',
        {
          code: 'P2002',
          meta: {
            modelName: 'EmployeeActivationToken',
            driverAdapterError: {
              cause: {
                kind: 'UniqueConstraintViolation',
                constraint: { fields: ['unrelated_unique_field'] },
              },
            },
          },
        },
      ],
      [
        'missing metadata',
        { code: 'P2002', meta: { modelName: 'EmployeeActivationToken' } },
      ],
      [
        'wrong model',
        {
          code: 'P2002',
          meta: {
            modelName: 'EmployeeCredential',
            driverAdapterError: {
              cause: {
                kind: 'UniqueConstraintViolation',
                constraint: { fields: ['token_hash'] },
              },
            },
          },
        },
      ],
      [
        'ambiguous fields',
        {
          code: 'P2002',
          meta: {
            modelName: 'EmployeeActivationToken',
            driverAdapterError: {
              cause: {
                kind: 'UniqueConstraintViolation',
                constraint: { fields: ['token_hash', 'employee_id'] },
              },
            },
          },
        },
      ],
    ])('fails safely for P2002 with %s', async (_label, error) => {
      harness.hooks.tokenCreateError = error;

      await expectCode(
        issue(tokenHash),
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
      );
    });

    it('serializes concurrent reissues so only the latest token remains outstanding', async () => {
      const [first, second] = await Promise.all([
        issue(tokenHash),
        issue(secondTokenHash),
      ]);

      expect([first, second]).toEqual(['ISSUED', 'ISSUED']);
      expect(harness.state.tokens).toHaveLength(2);
      expect(harness.state.tokens[0].revokedAt).toEqual(issuedAt);
      expect(harness.state.tokens[1].revokedAt).toBeNull();
      expect(harness.state.tokens[1].tokenHash).toEqual(secondTokenHash);
    });

    it('keeps committed issuance successful when disconnect fails', async () => {
      harness.disconnect.mockRejectedValue(new Error('cleanup detail'));

      await expect(issue(tokenHash)).resolves.toBe('ISSUED');
      expect(harness.state.tokens).toHaveLength(1);
    });
  });

  describe('activation transaction', () => {
    beforeEach(() => {
      harness.state.tokens.push(tokenRecord(tokenHash));
    });

    it('performs a read-only advisory check without acquiring the owner lock', async () => {
      await expect(checkEligibility(tokenHash)).resolves.toBe(true);

      expect(harness.events).toEqual([]);
      expect(harness.lockQueryText).toBe('');
      expect(harness.state.tokens[0].consumedAt).toBeNull();
      expect(harness.state.credential).toBeNull();
      expect(harness.state.owner.status).toBe(
        EmployeeStatus.PENDING_ACTIVATION,
      );
    });

    it.each([
      ['expired', () => (harness.state.tokens[0].expiresAt = issuedAt)],
      ['consumed', () => (harness.state.tokens[0].consumedAt = issuedAt)],
      ['revoked', () => (harness.state.tokens[0].revokedAt = issuedAt)],
      ['owner active', () => (harness.state.owner.status = EmployeeStatus.ACTIVE)],
      ['credential exists', () => (harness.state.credential = passwordHash)],
    ])('returns only false when advisory state is %s', async (_label, mutate) => {
      mutate();

      await expect(checkEligibility(tokenHash)).resolves.toBe(false);
    });

    it('keeps read-only cleanup failure semantics for advisory success', async () => {
      harness.disconnect.mockRejectedValue(new Error('cleanup detail'));

      await expectCode(
        checkEligibility(tokenHash),
        StoreAuthErrorCode.TENANT_CLEANUP_FAILED,
      );
      expect(harness.state.tokens[0].consumedAt).toBeNull();
    });

    it('atomically consumes the token, creates the credential, and activates the owner', async () => {
      await expect(activate(tokenHash)).resolves.toBeUndefined();

      expect(harness.state.tokens[0].consumedAt).toEqual(issuedAt);
      expect(harness.state.credential).toBe(passwordHash);
      expect(harness.state.passwordChangedAt).toEqual(issuedAt);
      expect(harness.state.owner.status).toBe(EmployeeStatus.ACTIVE);
      expect(harness.events).toEqual([
        'lock-owner',
        'verify-identity',
        'read-owner',
        'read-clock',
        'read-token',
        'consume-token',
        'create-credential',
        'activate-owner',
      ]);
    });

    it('rejects a token that expires while waiting for the owner lock', async () => {
      harness.state.tokens[0].expiresAt = new Date(
        issuedAt.getTime() + 1_000,
      );
      harness.hooks.advisoryClockTime = issuedAt;

      await expect(checkEligibility(tokenHash)).resolves.toBe(true);

      harness.hooks.transactionClockTime = new Date(
        issuedAt.getTime() + 2_000,
      );
      const before = cloneState(harness.state);

      await expectCode(
        activate(tokenHash),
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      );
      expect(harness.state).toEqual(before);
      expect(harness.state.tokens[0].consumedAt).toBeNull();
      expect(harness.state.credential).toBeNull();
      expect(harness.state.owner.status).toBe(
        EmployeeStatus.PENDING_ACTIVATION,
      );
    });

    it.each([
      ['not found', () => (harness.state.tokens = [])],
      [
        'expired',
        () =>
          (harness.state.tokens[0].expiresAt = new Date(
            issuedAt.getTime() - 1,
          )),
      ],
      ['expiration boundary', () => (harness.state.tokens[0].expiresAt = issuedAt)],
      ['consumed', () => (harness.state.tokens[0].consumedAt = issuedAt)],
      ['revoked', () => (harness.state.tokens[0].revokedAt = issuedAt)],
      ['wrong employee', () => (harness.state.tokens[0].employeeId = otherStoreId)],
    ])('rejects token that is %s without mutation', async (_label, mutate) => {
      mutate();
      const before = cloneState(harness.state);

      await expectCode(
        activate(tokenHash),
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      );
      expect(harness.state).toEqual(before);
    });

    it.each([
      EmployeeStatus.ACTIVE,
      EmployeeStatus.INACTIVE,
      EmployeeStatus.SUSPENDED,
    ])('rejects owner status %s without overwriting credentials', async (status) => {
      harness.state.owner.status = status;

      await expectCode(
        activate(tokenHash),
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      );
      expect(harness.state.credential).toBeNull();
      expect(harness.state.tokens[0].consumedAt).toBeNull();
    });

    it('rejects invalid activation mutation values before opening a transaction', async () => {
      harness.events.length = 0;

      await expectCode(
        harness.service.withResolvedTenant('demo-store', ({ tenantAccess }) =>
          tenantAccess.activateOwner({
            tokenHash: Buffer.alloc(31),
            passwordHash,
          }),
        ),
        StoreAuthErrorCode.OWNER_ACTIVATION_FAILED,
      );
      await expectCode(
        harness.service.withResolvedTenant('demo-store', ({ tenantAccess }) =>
          tenantAccess.activateOwner({
            tokenHash,
            passwordHash: '',
          }),
        ),
        StoreAuthErrorCode.OWNER_ACTIVATION_FAILED,
      );
      expect(harness.events).toEqual([]);
    });

    it.each([
      ['credential', () => (harness.state.credential = 'existing-hash')],
      ['role', () => (harness.state.owner.role.key = 'MANAGER')],
      ['store', () => (harness.state.owner.masterStoreId = otherStoreId)],
      ['identity', () => (harness.state.identityStoreId = otherStoreId)],
    ])('rejects invalid %s invariant', async (_label, mutate) => {
      mutate();
      const before = cloneState(harness.state);

      await expectCode(
        activate(tokenHash),
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      );
      expect(harness.state).toEqual(before);
    });

    it.each(['tokenFenceCount', 'statusFenceCount'] as const)(
      'rolls back when %s is zero',
      async (hook) => {
        harness.hooks[hook] = 0;
        const before = cloneState(harness.state);

        await expectCode(
          activate(tokenHash),
          StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
        );
        expect(harness.state).toEqual(before);
      },
    );

    it.each(['credentialError', 'statusError'] as const)(
      'rolls back every mutation after %s',
      async (hook) => {
        harness.hooks[hook] = new Error(`forced ${hook}`);
        const before = cloneState(harness.state);

        await expectCode(
          activate(tokenHash),
          StoreAuthErrorCode.OWNER_ACTIVATION_FAILED,
        );
        expect(harness.state).toEqual(before);
      },
    );

    it('allows exactly one of two simultaneous activations to commit', async () => {
      const results = await Promise.allSettled([
        activate(tokenHash),
        activate(tokenHash),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        code: StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      });
      expect(harness.state.owner.status).toBe(EmployeeStatus.ACTIVE);
      expect(harness.state.credential).toBe(passwordHash);
    });

    it('makes retry after a committed activation invalid without overwriting password', async () => {
      await activate(tokenHash);
      const committedHash = harness.state.credential;

      await expectCode(
        activate(tokenHash, `${passwordHash}-replacement`),
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      );
      expect(harness.state.credential).toBe(committedHash);
    });

    it('serializes activation before reissue so the later reissue is ineligible', async () => {
      const results = await Promise.allSettled([
        activate(tokenHash),
        issue(secondTokenHash),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: {
          code: StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT,
        },
      });
    });

    it('serializes reissue before activation so the old token is revoked', async () => {
      const results = await Promise.allSettled([
        issue(secondTokenHash),
        activate(tokenHash),
      ]);

      expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'ISSUED' });
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { code: StoreAuthErrorCode.OWNER_ACTIVATION_INVALID },
      });
      expect(harness.state.owner.status).toBe(
        EmployeeStatus.PENDING_ACTIVATION,
      );
      expect(harness.state.credential).toBeNull();
      expect(harness.state.tokens[0].revokedAt).toEqual(issuedAt);
    });

    it('keeps committed activation successful when disconnect fails', async () => {
      harness.disconnect.mockRejectedValue(new Error('cleanup detail'));

      await expect(activate(tokenHash)).resolves.toBeUndefined();
      expect(harness.state.owner.status).toBe(EmployeeStatus.ACTIVE);
      expect(harness.state.credential).toBe(passwordHash);
    });

    it('preserves a pre-commit error when disconnect also fails', async () => {
      harness.state.tokens = [];
      harness.disconnect.mockRejectedValue(new Error('cleanup detail'));

      await expectCode(
        activate(tokenHash),
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      );
    });
  });

  describe('refresh session transaction', () => {
    beforeEach(() => {
      harness.state.owner.status = EmployeeStatus.ACTIVE;
      harness.state.credential = passwordHash;
    });

    it('locks and revalidates the ACTIVE owner before persisting only the hash', async () => {
      const outcome = await createRefreshSession(tokenHash);

      expect(outcome).toEqual({
        sessionId: 'ffffffff-ffff-4fff-8fff-000000000001',
        issuedAt,
        expiresAt,
      });
      expect(harness.state.sessions).toHaveLength(1);
      expect(harness.state.sessions[0]).toMatchObject({
        employeeId: ownerId,
        refreshTokenHash: tokenHash,
        issuedAt,
        expiresAt,
        revokedAt: null,
      });
      expect(harness.events).toEqual([
        'lock-owner',
        'verify-identity',
        'read-owner',
        'read-clock',
        'create-refresh-session',
      ]);
      expect(harness.lockQueryText).toContain('FOR UPDATE');
      expect(harness.lockQueryValues).toEqual([ownerId]);
    });

    it('uses database time obtained after the owner lock for issuedAt and expiry', async () => {
      harness.hooks.transactionClockTime = new Date(
        '2026-08-15T09:30:00.000Z',
      );

      const outcome = await createRefreshSession(tokenHash, 60);

      expect(harness.events.indexOf('lock-owner')).toBeLessThan(
        harness.events.indexOf('read-clock'),
      );
      expect(outcome).toMatchObject({
        issuedAt: new Date('2026-08-15T09:30:00.000Z'),
        expiresAt: new Date('2026-08-15T10:30:00.000Z'),
      });
      expect(harness.state.sessions[0].issuedAt).toEqual(
        new Date('2026-08-15T09:30:00.000Z'),
      );
    });

    it.each([
      EmployeeStatus.PENDING_ACTIVATION,
      EmployeeStatus.INACTIVE,
      EmployeeStatus.SUSPENDED,
    ])('rejects owner status %s without creating a session', async (status) => {
      harness.state.owner.status = status;

      await expectCode(
        createRefreshSession(tokenHash),
        StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
      );
      expect(harness.state.sessions).toEqual([]);
      expect(harness.events).not.toContain('read-clock');
    });

    it.each([
      ['missing owner', () => (harness.state.owner.isStoreOwner = false)],
      ['credential', () => (harness.state.credential = null)],
      ['role key', () => (harness.state.owner.role.key = 'MANAGER')],
      ['role name', () => (harness.state.owner.role.name = 'Store Owner')],
      ['system role', () => (harness.state.owner.role.isSystem = false)],
      ['store relationship', () => (harness.state.owner.masterStoreId = otherStoreId)],
      ['tenant identity', () => (harness.state.identityStoreId = otherStoreId)],
    ])('rejects invalid owner %s invariant', async (_label, mutate) => {
      mutate();

      await expectCode(
        createRefreshSession(tokenHash),
        StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
      );
      expect(harness.state.sessions).toEqual([]);
    });

    it('rejects an owner ID that is missing without locking another owner', async () => {
      await expectCode(
        createRefreshSession(
          tokenHash,
          1_440,
          'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        ),
        StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
      );
      expect(harness.state.sessions).toEqual([]);
    });

    it('fails closed on invalid hash, TTL, database precision, and arithmetic overflow', async () => {
      await expectCode(
        createRefreshSession(Buffer.alloc(31)),
        StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
      );
      await expectCode(
        createRefreshSession(tokenHash, 0),
        StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
      );

      harness.hooks.transactionClockTime = new Date(issuedAt.getTime() + 1);
      await expectCode(
        createRefreshSession(tokenHash),
        StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
      );

      harness.hooks.transactionClockTime = issuedAt;
      await expectCode(
        createRefreshSession(tokenHash, Number.MAX_SAFE_INTEGER),
        StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
      );
      expect(harness.state.sessions).toEqual([]);
    });

    it('returns only an exact hash collision and rolls the transaction back', async () => {
      harness.state.sessions.push(
        refreshSessionRecord(tokenHash),
      );

      await expect(createRefreshSession(tokenHash)).resolves.toBe(
        'REFRESH_TOKEN_HASH_COLLISION',
      );
      expect(harness.state.sessions).toHaveLength(1);
    });

    it('sanitizes unrelated persistence failures and rolls back', async () => {
      harness.hooks.sessionCreateError = new Error(
        'database topology and raw refresh token detail',
      );

      await expectCode(
        createRefreshSession(tokenHash),
        StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
      );
      expect(harness.state.sessions).toEqual([]);
    });

    it('supports multiple concurrent sessions for the same owner', async () => {
      const outcomes = await Promise.all([
        createRefreshSession(tokenHash),
        createRefreshSession(secondTokenHash),
      ]);

      expect(outcomes).toHaveLength(2);
      expect(harness.state.sessions).toHaveLength(2);
      expect(harness.state.sessions.map((session) => session.refreshTokenHash)).toEqual([
        tokenHash,
        secondTokenHash,
      ]);
      expect(harness.state.sessions.every((session) => session.revokedAt === null)).toBe(true);
    });

    it('keeps a committed session successful when disconnect fails', async () => {
      harness.disconnect.mockRejectedValue(new Error('cleanup detail'));

      await expect(createRefreshSession(tokenHash)).resolves.toMatchObject({
        sessionId: expect.any(String),
      });
      expect(harness.state.sessions).toHaveLength(1);
    });

    it('preserves a pre-commit owner failure when disconnect also fails', async () => {
      harness.state.owner.status = EmployeeStatus.SUSPENDED;
      harness.disconnect.mockRejectedValue(new Error('cleanup detail'));

      await expectCode(
        createRefreshSession(tokenHash),
        StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
      );
    });
  });

  describe('refresh rotation transaction', () => {
    const refreshTime = new Date('2026-08-10T18:00:00.000Z');
    const replacementExpiresAt = new Date('2026-08-11T18:00:00.000Z');

    beforeEach(() => {
      harness.state.owner.status = EmployeeStatus.ACTIVE;
      harness.state.credential = passwordHash;
      harness.state.sessions.push(refreshSessionRecord(tokenHash));
      harness.hooks.transactionClockTime = refreshTime;
    });

    it('locks the session and owner, revalidates state, and rotates only the digest', async () => {
      const issuer = jest.fn(async (context) => {
        harness.events.push('sign-access-token');
        expect(context).toEqual({
          ownerId,
          storeId,
          sessionId: 'ffffffff-ffff-4fff-8fff-000000000001',
          issuedAt: refreshTime,
        });
        return {
          accessToken: 'signed.access.token',
          expiresAt: new Date('2026-08-10T18:15:00.000Z'),
        };
      });

      const outcome = await rotateRefreshSession(
        tokenHash,
        secondTokenHash,
        issuer,
      );

      expect(outcome).toEqual({
        accessToken: 'signed.access.token',
        accessTokenExpiresAt: new Date('2026-08-10T18:15:00.000Z'),
        refreshTokenExpiresAt: replacementExpiresAt,
      });
      expect(Object.keys(outcome as object).sort()).toEqual([
        'accessToken',
        'accessTokenExpiresAt',
        'refreshTokenExpiresAt',
      ]);
      expect(harness.state.sessions[0]).toMatchObject({
        id: 'ffffffff-ffff-4fff-8fff-000000000001',
        employeeId: ownerId,
        refreshTokenHash: secondTokenHash,
        issuedAt: refreshTime,
        expiresAt: replacementExpiresAt,
        revokedAt: null,
      });
      expect(harness.events).toEqual([
        'lock-refresh-session',
        'lock-owner',
        'verify-identity',
        'read-refresh-session',
        'read-owner',
        'read-clock',
        'rotate-refresh-session',
        'sign-access-token',
      ]);
      expect(harness.lockQueryText).toContain('FOR UPDATE');
      expect(issuer).toHaveBeenCalledTimes(1);
    });

    it('makes the old digest immediately unusable while the replacement remains rotatable', async () => {
      await expect(
        rotateRefreshSession(tokenHash, secondTokenHash),
      ).resolves.toMatchObject({ accessToken: 'signed.access.token' });
      await expect(
        rotateRefreshSession(tokenHash, Buffer.alloc(32, 23)),
      ).resolves.toBe('INVALID_REFRESH');
      await expect(
        rotateRefreshSession(secondTokenHash, Buffer.alloc(32, 24)),
      ).resolves.toMatchObject({ accessToken: 'signed.access.token' });
    });

    it.each([
      ['revoked', () => {
        harness.state.sessions[0].revokedAt = new Date(refreshTime);
      }],
      ['expired', () => {
        harness.state.sessions[0].expiresAt = new Date(refreshTime.getTime() - 1);
      }],
      ['expiry equality', () => {
        harness.state.sessions[0].expiresAt = new Date(refreshTime);
      }],
      ['future issuance', () => {
        harness.state.sessions[0].issuedAt = new Date(refreshTime.getTime() + 1_000);
      }],
      ['stored hash mismatch', () => {
        harness.hooks.sessionReadHash = Buffer.alloc(32, 99);
      }],
    ])('rejects a %s session without mutation or signing', async (_label, mutate) => {
      mutate();
      const issuer = jest.fn();

      await expect(
        rotateRefreshSession(tokenHash, secondTokenHash, issuer),
      ).resolves.toBe('INVALID_REFRESH');
      expect(issuer).not.toHaveBeenCalled();
      expect(harness.events).not.toContain('rotate-refresh-session');
    });

    it('rejects an unknown digest before owner or clock access', async () => {
      const issuer = jest.fn();

      await expect(
        rotateRefreshSession(Buffer.alloc(32, 88), secondTokenHash, issuer),
      ).resolves.toBe('INVALID_REFRESH');
      expect(harness.events).toEqual(['lock-refresh-session']);
      expect(issuer).not.toHaveBeenCalled();
    });

    it('rejects a refresh session whose owner row is missing', async () => {
      harness.hooks.ownerLockMissing = true;
      const issuer = jest.fn();

      await expect(
        rotateRefreshSession(tokenHash, secondTokenHash, issuer),
      ).resolves.toBe('INVALID_REFRESH');
      expect(harness.state.sessions[0].refreshTokenHash).toEqual(tokenHash);
      expect(issuer).not.toHaveBeenCalled();
      expect(harness.events).not.toContain('read-clock');
    });

    it.each([
      ['PENDING_ACTIVATION', () => {
        harness.state.owner.status = EmployeeStatus.PENDING_ACTIVATION;
      }],
      ['INACTIVE', () => {
        harness.state.owner.status = EmployeeStatus.INACTIVE;
      }],
      ['SUSPENDED', () => {
        harness.state.owner.status = EmployeeStatus.SUSPENDED;
      }],
      ['not designated owner', () => {
        harness.state.owner.isStoreOwner = false;
      }],
      ['wrong store', () => {
        harness.state.owner.masterStoreId = otherStoreId;
      }],
      ['wrong role key', () => {
        harness.state.owner.role.key = 'MANAGER';
      }],
      ['wrong role name', () => {
        harness.state.owner.role.name = 'Store Owner';
      }],
      ['non-system role', () => {
        harness.state.owner.role.isSystem = false;
      }],
      ['missing credential', () => {
        harness.state.credential = null;
      }],
    ])('revokes an otherwise usable session for ineligible owner state: %s', async (_label, mutate) => {
      mutate();
      const issuer = jest.fn();

      await expect(
        rotateRefreshSession(tokenHash, secondTokenHash, issuer),
      ).resolves.toBe('INVALID_REFRESH_REVOKED');
      expect(harness.state.sessions[0].revokedAt).toEqual(refreshTime);
      expect(harness.state.sessions[0].refreshTokenHash).toEqual(tokenHash);
      expect(issuer).not.toHaveBeenCalled();
    });

    it('blocks a transaction-time tenant identity mismatch without rotation', async () => {
      harness.state.identityStoreId = otherStoreId;

      await expectCode(
        rotateRefreshSession(tokenHash, secondTokenHash),
        StoreAuthErrorCode.AUTH_REFRESH_INVALID,
      );
      expect(harness.state.sessions[0].refreshTokenHash).toEqual(tokenHash);
      expect(harness.events).not.toContain('read-clock');
    });

    it('allows exactly one concurrent rotation of the same original digest', async () => {
      const outcomes = await Promise.all([
        rotateRefreshSession(tokenHash, secondTokenHash),
        rotateRefreshSession(tokenHash, Buffer.alloc(32, 23)),
      ]);

      expect(
        outcomes.filter(
          (outcome) =>
            typeof outcome === 'object' && outcome !== null,
        ),
      ).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'INVALID_REFRESH')).toHaveLength(1);
      expect(harness.state.sessions).toHaveLength(1);
    });

    it('retries only the narrow replacement-digest collision and rolls back the old row', async () => {
      harness.state.sessions.push(refreshSessionRecord(secondTokenHash));
      const original = { ...harness.state.sessions[0] };

      await expect(
        rotateRefreshSession(tokenHash, secondTokenHash),
      ).resolves.toBe('REFRESH_TOKEN_HASH_COLLISION');
      expect(harness.state.sessions[0]).toMatchObject(original);
      expect(harness.state.sessions[0].refreshTokenHash).toEqual(tokenHash);
    });

    it('rolls rotation back on update, signing, and commit failures', async () => {
      harness.hooks.sessionUpdateError = new Error('database detail');
      await expectCode(
        rotateRefreshSession(tokenHash, secondTokenHash),
        StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      );
      expect(harness.state.sessions[0].refreshTokenHash).toEqual(tokenHash);

      delete harness.hooks.sessionUpdateError;
      await expectCode(
        rotateRefreshSession(tokenHash, secondTokenHash, async () => {
          throw new Error('signer detail');
        }),
        StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      );
      expect(harness.state.sessions[0].refreshTokenHash).toEqual(tokenHash);

      harness.hooks.transactionCommitError = new Error('commit detail');
      await expectCode(
        rotateRefreshSession(tokenHash, secondTokenHash),
        StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      );
      expect(harness.state.sessions[0].refreshTokenHash).toEqual(tokenHash);
    });

    it('rolls an ineligibility revocation back on persistence failure', async () => {
      harness.state.owner.status = EmployeeStatus.SUSPENDED;
      harness.hooks.sessionUpdateError = new Error('revocation detail');

      await expectCode(
        rotateRefreshSession(tokenHash, secondTokenHash),
        StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      );
      expect(harness.state.sessions[0].revokedAt).toBeNull();
      expect(harness.state.sessions[0].refreshTokenHash).toEqual(tokenHash);
    });

    it('fails closed on a fence miss, invalid database precision, and expiry overflow', async () => {
      harness.hooks.sessionUpdateFenceCount = 0;
      await expectCode(
        rotateRefreshSession(tokenHash, secondTokenHash),
        StoreAuthErrorCode.AUTH_REFRESH_INVALID,
      );
      expect(harness.state.sessions[0].refreshTokenHash).toEqual(tokenHash);

      delete harness.hooks.sessionUpdateFenceCount;
      harness.hooks.transactionClockTime = new Date(refreshTime.getTime() + 1);
      await expectCode(
        rotateRefreshSession(tokenHash, secondTokenHash),
        StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      );

      harness.hooks.transactionClockTime = refreshTime;
      await expectCode(
        rotateRefreshSession(
          tokenHash,
          secondTokenHash,
          undefined,
          Number.MAX_SAFE_INTEGER,
        ),
        StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      );
    });

    it('rejects invalid digests, equal replacement material, and invalid TTL before mutation', async () => {
      await expectCode(
        rotateRefreshSession(Buffer.alloc(31), secondTokenHash),
        StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      );
      await expectCode(
        rotateRefreshSession(tokenHash, Buffer.alloc(31)),
        StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      );
      await expectCode(
        rotateRefreshSession(tokenHash, tokenHash),
        StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      );
      await expectCode(
        rotateRefreshSession(tokenHash, secondTokenHash, undefined, 0),
        StoreAuthErrorCode.AUTH_REFRESH_FAILED,
      );
      expect(harness.state.sessions[0].refreshTokenHash).toEqual(tokenHash);
    });

    it('rotates only the selected device session', async () => {
      const phoneBHash = Buffer.alloc(32, 41);
      const phoneB = refreshSessionRecord(phoneBHash);
      harness.state.sessions.push(phoneB);

      await rotateRefreshSession(tokenHash, secondTokenHash);

      expect(harness.state.sessions[0].refreshTokenHash).toEqual(
        secondTokenHash,
      );
      expect(harness.state.sessions[1]).toEqual(phoneB);
    });

    it('keeps committed rotation and ineligibility revocation successful when disconnect fails', async () => {
      harness.disconnect.mockRejectedValue(new Error('cleanup detail'));

      await expect(
        rotateRefreshSession(tokenHash, secondTokenHash),
      ).resolves.toMatchObject({ accessToken: 'signed.access.token' });

      harness = createTransactionHarness();
      (TenantPrismaClient as unknown as jest.Mock).mockReturnValue(
        harness.client,
      );
      harness.state.owner.status = EmployeeStatus.SUSPENDED;
      harness.state.credential = passwordHash;
      harness.state.sessions.push(refreshSessionRecord(tokenHash));
      harness.hooks.transactionClockTime = refreshTime;
      harness.disconnect.mockRejectedValue(new Error('cleanup detail'));

      await expect(
        rotateRefreshSession(tokenHash, secondTokenHash),
      ).resolves.toBe('INVALID_REFRESH_REVOKED');
    });
  });

  async function issue(hash: Buffer) {
    const outcome = await harness.service.withResolvedTenant(
      'demo-store',
      ({ tenantAccess }) =>
      tenantAccess.issueOwnerActivation({
        tokenHash: Buffer.from(hash),
        ttlMinutes: 1_440,
      }),
    );

    return outcome === 'TOKEN_HASH_COLLISION'
      ? outcome
      : ('ISSUED' as const);
  }

  async function activate(hash: Buffer, encodedHash = passwordHash) {
    await harness.service.withResolvedTenant('demo-store', ({ tenantAccess }) =>
      tenantAccess.activateOwner({
        tokenHash: Buffer.from(hash),
        passwordHash: encodedHash,
      }),
    );
  }

  async function createRefreshSession(
    hash: Buffer,
    ttlMinutes = 1_440,
    requestedOwnerId = ownerId,
  ) {
    return harness.service.withResolvedTenant(
      'demo-store',
      ({ tenantAccess }) =>
        tenantAccess.createOwnerRefreshSession({
          ownerId: requestedOwnerId,
          refreshTokenHash: Buffer.from(hash),
          ttlMinutes,
        }),
    );
  }

  async function rotateRefreshSession(
    presentedHash: Buffer,
    replacementHash: Buffer,
    issuer: ((input: {
      ownerId: string;
      storeId: string;
      sessionId: string;
      issuedAt: Date;
    }) => Promise<{ accessToken: string; expiresAt: Date }>) | undefined =
      async () => ({
        accessToken: 'signed.access.token',
        expiresAt: new Date('2026-08-10T18:15:00.000Z'),
      }),
    ttlMinutes = 1_440,
  ) {
    return harness.service.withResolvedTenant(
      'demo-store',
      ({ tenantAccess }) =>
        tenantAccess.rotateOwnerRefreshSession(
          {
            presentedRefreshTokenHash: Buffer.from(presentedHash),
            replacementRefreshTokenHash: Buffer.from(replacementHash),
            ttlMinutes,
          },
          issuer,
        ),
    );
  }

  async function checkEligibility(hash: Buffer) {
    return harness.service.withResolvedTenant('demo-store', ({ tenantAccess }) =>
      tenantAccess.checkOwnerActivationEligibility({
        tokenHash: Buffer.from(hash),
      }),
    );
  }

  function tokenRecord(
    hash: Buffer,
    overrides: Partial<ActivationTokenState> = {},
  ): ActivationTokenState {
    return {
      id: `dddddddd-dddd-4ddd-8ddd-${String(harness.state.tokens.length + 1).padStart(12, '0')}`,
      employeeId: ownerId,
      tokenHash: Buffer.from(hash),
      expiresAt,
      consumedAt: null,
      revokedAt: null,
      createdAt: new Date('2026-08-09T00:00:00.000Z'),
      ...overrides,
    };
  }

  function refreshSessionRecord(hash: Buffer): RefreshSessionState {
    return {
      id: `ffffffff-ffff-4fff-8fff-${String(harness.state.sessions.length + 1).padStart(12, '0')}`,
      employeeId: ownerId,
      refreshTokenHash: Buffer.from(hash),
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
      revokedAt: null,
    };
  }

  function createTransactionHarness(): TransactionHarness {
    // This stateful harness queues only when the modeled FOR UPDATE query runs.
    // It models rollback/fences; disposable PostgreSQL tests remain authoritative
    // for actual row-lock scheduling and adapter error metadata.
    let state = initialState();
    let ownerLockTail = Promise.resolve();
    const events: string[] = [];
    const hooks: TransactionHooks = {};
    const disconnect = jest.fn().mockResolvedValue(undefined);
    let lockQueryText = '';
    let lockQueryValues: unknown[] = [];

    const client = {
      $queryRaw: jest.fn(async () => [
        {
          authoritativeTime:
            hooks.advisoryClockTime ?? new Date(issuedAt.getTime()),
        },
      ]),
      tenantIdentity: {
        findUnique: jest.fn(async () => ({
          id: 1,
          masterStoreId: storeId,
        })),
      },
      employee: {
        findMany: jest.fn(async () => {
          if (!state.owner.isStoreOwner) return [];
          return [
            {
              ...state.owner,
              role: { ...state.owner.role },
              credential:
                state.credential === null
                  ? null
                  : { employeeId: state.owner.id },
            },
          ];
        }),
      },
      employeeActivationToken: {
        findUnique: jest.fn(async ({ where }) => {
          const token = state.tokens.find((candidate) =>
            candidate.tokenHash.equals(where.tokenHash),
          );
          return token ? cloneToken(token) : null;
        }),
      },
      $transaction: jest.fn(async (operation) => {
        let release: () => void = () => undefined;
        let draft: TenantActivationState | undefined;
        let ownerLockAcquired = false;
        const acquireOwnerLock = async () => {
          if (ownerLockAcquired) return;
          const precedingOwnerLock = ownerLockTail;
          ownerLockTail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await precedingOwnerLock;
          draft = cloneState(state);
          ownerLockAcquired = true;
        };
        const requireDraft = () => {
          if (!draft) throw new Error('Owner row lock was not acquired');
          return draft;
        };
        const transaction = createTransaction(
          requireDraft,
          acquireOwnerLock,
        );

        try {
          const result = await operation(transaction);
          if (hooks.transactionCommitError) {
            throw hooks.transactionCommitError;
          }
          state = requireDraft();
          return result;
        } finally {
          if (ownerLockAcquired) release();
        }
      }),
      $disconnect: disconnect,
    };

    function createTransaction(
      requireDraft: () => TenantActivationState,
      acquireOwnerLock: () => Promise<void>,
    ) {
      return {
        $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const queryText = strings.join('?');

          if (queryText.includes('clock_timestamp')) {
            events.push('read-clock');
            return [
              {
                authoritativeTime:
                  hooks.transactionClockTime ??
                  new Date(issuedAt.getTime()),
              },
            ];
          }

          await acquireOwnerLock();
          const draft = requireDraft();
          if (queryText.includes('employee_refresh_sessions')) {
            events.push('lock-refresh-session');
            lockQueryText = queryText;
            lockQueryValues = values;
            const presentedHash = values[0];
            const session = Buffer.isBuffer(presentedHash)
              ? draft.sessions.find((candidate) =>
                  candidate.refreshTokenHash.equals(presentedHash),
                )
              : undefined;
            return session
              ? [{ id: session.id, employeeId: session.employeeId }]
              : [];
          }

          events.push('lock-owner');
          lockQueryText = queryText;
          lockQueryValues = values;
          if (hooks.ownerLockMissing) return [];
          return queryText.includes('is_store_owner') &&
            !draft.owner.isStoreOwner
            ? []
            : [{ id: draft.owner.id }];
        }),
        tenantIdentity: {
          findUnique: jest.fn(async () => {
            const draft = requireDraft();
            events.push('verify-identity');
            return { id: 1, masterStoreId: draft.identityStoreId };
          }),
        },
        employee: {
          findUnique: jest.fn(async () => {
            const draft = requireDraft();
            events.push('read-owner');
            return {
              ...draft.owner,
              role: { ...draft.owner.role },
              credential:
                draft.credential === null
                  ? null
                  : { employeeId: draft.owner.id },
            };
          }),
          updateMany: jest.fn(async () => {
            const draft = requireDraft();
            events.push('activate-owner');
            if (hooks.statusError) throw hooks.statusError;
            if (hooks.statusFenceCount === 0) return { count: 0 };
            if (draft.owner.status !== EmployeeStatus.PENDING_ACTIVATION) {
              return { count: 0 };
            }
            draft.owner.status = EmployeeStatus.ACTIVE;
            return { count: 1 };
          }),
        },
        employeeCredential: {
          create: jest.fn(async ({ data }) => {
            const draft = requireDraft();
            events.push('create-credential');
            if (hooks.credentialError) throw hooks.credentialError;
            if (draft.credential !== null) {
              throw {
                code: 'P2002',
                meta: {
                  modelName: 'EmployeeCredential',
                  driverAdapterError: {
                    cause: {
                      kind: 'UniqueConstraintViolation',
                      constraint: { fields: ['employee_id'] },
                    },
                  },
                },
              };
            }
            draft.credential = data.passwordHash;
            draft.passwordChangedAt = new Date(data.passwordChangedAt);
            return { employeeId: data.employeeId };
          }),
        },
        employeeActivationToken: {
          findUnique: jest.fn(async ({ where }) => {
            const draft = requireDraft();
            events.push('read-token');
            const token = draft.tokens.find((candidate) =>
              candidate.tokenHash.equals(where.tokenHash),
            );
            return token ? cloneToken(token) : null;
          }),
          updateMany: jest.fn(async ({ where, data }) => {
            const draft = requireDraft();
            if ('revokedAt' in data) {
              events.push('revoke-outstanding');
              let count = 0;
              for (const token of draft.tokens) {
                if (
                  token.employeeId === where.employeeId &&
                  token.consumedAt === null &&
                  token.revokedAt === null
                ) {
                  token.revokedAt = new Date(data.revokedAt);
                  count += 1;
                }
              }
              return { count };
            }

            events.push('consume-token');
            if (hooks.tokenFenceCount === 0) return { count: 0 };
            const token = draft.tokens.find(
              (candidate) =>
                candidate.id === where.id &&
                candidate.employeeId === where.employeeId &&
                candidate.tokenHash.equals(where.tokenHash) &&
                candidate.consumedAt === null &&
                candidate.revokedAt === null &&
                candidate.expiresAt.getTime() > where.expiresAt.gt.getTime(),
            );
            if (!token) return { count: 0 };
            token.consumedAt = new Date(data.consumedAt);
            return { count: 1 };
          }),
          create: jest.fn(async ({ data }) => {
            const draft = requireDraft();
            events.push('create-token');
            if (hooks.tokenCreateError) throw hooks.tokenCreateError;
            if (
              draft.tokens.some((candidate) =>
                candidate.tokenHash.equals(data.tokenHash),
              )
            ) {
              throw {
                code: 'P2002',
                meta: {
                  modelName: 'EmployeeActivationToken',
                  driverAdapterError: {
                    cause: {
                      kind: 'UniqueConstraintViolation',
                      constraint: { fields: ['token_hash'] },
                    },
                  },
                },
              };
            }
            if (
              draft.tokens.some(
                (candidate) =>
                  candidate.employeeId === data.employeeId &&
                  candidate.consumedAt === null &&
                  candidate.revokedAt === null,
              )
            ) {
              throw {
                code: 'P2002',
                meta: {
                  modelName: 'EmployeeActivationToken',
                  driverAdapterError: {
                    cause: {
                      kind: 'UniqueConstraintViolation',
                      constraint: { fields: ['employee_id'] },
                    },
                  },
                },
              };
            }
            const id = `eeeeeeee-eeee-4eee-8eee-${String(draft.tokens.length + 1).padStart(12, '0')}`;
            draft.tokens.push({
              id,
              employeeId: data.employeeId,
              tokenHash: Buffer.from(data.tokenHash),
              expiresAt: new Date(data.expiresAt),
              consumedAt: null,
              revokedAt: null,
              createdAt: new Date(data.createdAt),
            });
            return { id };
          }),
        },
        employeeRefreshSession: {
          findUnique: jest.fn(async ({ where }) => {
            const draft = requireDraft();
            events.push('read-refresh-session');
            const session = draft.sessions.find(
              (candidate) => candidate.id === where.id,
            );
            if (!session) return null;
            const cloned = {
              ...session,
              refreshTokenHash: Buffer.from(session.refreshTokenHash),
              issuedAt: new Date(session.issuedAt),
              expiresAt: new Date(session.expiresAt),
              revokedAt: session.revokedAt
                ? new Date(session.revokedAt)
                : null,
            };
            if (hooks.sessionReadHash) {
              cloned.refreshTokenHash = Buffer.from(hooks.sessionReadHash);
            }
            return cloned;
          }),
          create: jest.fn(async ({ data }) => {
            const draft = requireDraft();
            events.push('create-refresh-session');
            if (hooks.sessionCreateError) throw hooks.sessionCreateError;
            if (
              draft.sessions.some((candidate) =>
                candidate.refreshTokenHash.equals(data.refreshTokenHash),
              )
            ) {
              throw {
                code: 'P2002',
                meta: {
                  modelName: 'EmployeeRefreshSession',
                  driverAdapterError: {
                    cause: {
                      kind: 'UniqueConstraintViolation',
                      constraint: { fields: ['refresh_token_hash'] },
                    },
                  },
                },
              };
            }
            const id = `ffffffff-ffff-4fff-8fff-${String(draft.sessions.length + 1).padStart(12, '0')}`;
            draft.sessions.push({
              id,
              employeeId: data.employeeId,
              refreshTokenHash: Buffer.from(data.refreshTokenHash),
              issuedAt: new Date(data.issuedAt),
              expiresAt: new Date(data.expiresAt),
              revokedAt: null,
            });
            return { id };
          }),
          updateMany: jest.fn(async ({ where, data }) => {
            const draft = requireDraft();
            events.push(
              data.revokedAt ? 'revoke-refresh-session' : 'rotate-refresh-session',
            );
            if (hooks.sessionUpdateError) throw hooks.sessionUpdateError;
            if (hooks.sessionUpdateFenceCount === 0) return { count: 0 };
            const session = draft.sessions.find(
              (candidate) =>
                candidate.id === where.id &&
                candidate.employeeId === where.employeeId &&
                candidate.refreshTokenHash.equals(where.refreshTokenHash) &&
                candidate.revokedAt === null &&
                (where.expiresAt === undefined ||
                  candidate.expiresAt.getTime() >
                    where.expiresAt.gt.getTime()),
            );
            if (!session) return { count: 0 };
            if (data.revokedAt) {
              session.revokedAt = new Date(data.revokedAt);
              return { count: 1 };
            }
            if (
              data.refreshTokenHash &&
              draft.sessions.some(
                (candidate) =>
                  candidate.id !== session.id &&
                  candidate.refreshTokenHash.equals(data.refreshTokenHash),
              )
            ) {
              throw {
                code: 'P2002',
                meta: {
                  modelName: 'EmployeeRefreshSession',
                  driverAdapterError: {
                    cause: {
                      kind: 'UniqueConstraintViolation',
                      constraint: { fields: ['refresh_token_hash'] },
                    },
                  },
                },
              };
            }
            session.refreshTokenHash = Buffer.from(data.refreshTokenHash);
            session.issuedAt = new Date(data.issuedAt);
            session.expiresAt = new Date(data.expiresAt);
            return { count: 1 };
          }),
        },
      };
    }

    const credentialEncryptionService = {
      decryptPassword: jest.fn().mockReturnValue('tenant-password'),
    } as unknown as TenantCredentialEncryptionService;
    const service = new StoreTenantAccessService(
      {
        store: {
          findUnique: jest.fn().mockResolvedValue({
            id: storeId,
            storeSlug: 'demo-store',
            tenantDatabase: {
              id: tenantDatabaseId,
              storeId,
              status: TenantProvisioningStatus.READY,
              databaseName: 'tenant_db_12345678123442348123456789012345',
              databaseHost: 'db.example.test',
              databasePort: 5432,
              databaseUser:
                'tenant_user_12345678123442348123456789012345',
              databasePasswordEncrypted: 'authenticated-envelope',
              encryptionKeyVersion: 1,
            },
          }),
        },
      } as unknown as PrismaService,
      {
        getTenantAccessConfiguration: jest.fn().mockReturnValue({
          tenantDatabaseHost: 'db.example.test',
          tenantDatabasePort: 5432,
          tenantDatabaseSslMode: 'disable',
          tenantPostgresConnectionTimeoutMs: 1_000,
          encryptionKeyVersion: 1,
          encryptionKey: new TenantProvisioningEncryptionKey(
            Buffer.alloc(32, 4),
          ),
        }),
      } as unknown as TenantProvisioningConfigService,
      credentialEncryptionService,
    );

    return {
      service,
      client,
      disconnect,
      events,
      hooks,
      get state() {
        return state;
      },
      get lockQueryText() {
        return lockQueryText;
      },
      get lockQueryValues() {
        return lockQueryValues;
      },
    };
  }

  function initialState(): TenantActivationState {
    return {
      identityStoreId: storeId,
      owner: {
        id: ownerId,
        status: EmployeeStatus.PENDING_ACTIVATION,
        isStoreOwner: true,
        masterStoreId: storeId,
        roleId,
        role: { key: 'OWNER', name: 'Owner', isSystem: true },
      },
      credential: null,
      passwordChangedAt: null,
      tokens: [],
      sessions: [],
    };
  }
});

interface ActivationTokenState {
  id: string;
  employeeId: string;
  tokenHash: Buffer;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

interface TenantActivationState {
  identityStoreId: string;
  owner: {
    id: string;
    status: EmployeeStatus;
    isStoreOwner: boolean;
    masterStoreId: string;
    roleId: string;
    role: { key: string; name: string; isSystem: boolean };
  };
  credential: string | null;
  passwordChangedAt: Date | null;
  tokens: ActivationTokenState[];
  sessions: RefreshSessionState[];
}

interface RefreshSessionState {
  id: string;
  employeeId: string;
  refreshTokenHash: Buffer;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface TransactionHooks {
  tokenCreateError?: unknown;
  credentialError?: unknown;
  statusError?: unknown;
  tokenFenceCount?: number;
  statusFenceCount?: number;
  advisoryClockTime?: Date;
  transactionClockTime?: Date;
  sessionCreateError?: unknown;
  sessionUpdateError?: unknown;
  sessionUpdateFenceCount?: number;
  sessionReadHash?: Buffer;
  transactionCommitError?: unknown;
  ownerLockMissing?: boolean;
}

interface TransactionHarness {
  service: StoreTenantAccessService;
  client: object;
  disconnect: jest.Mock;
  state: TenantActivationState;
  events: string[];
  hooks: TransactionHooks;
  lockQueryText: string;
  lockQueryValues: unknown[];
}

function cloneState(state: TenantActivationState): TenantActivationState {
  return {
    identityStoreId: state.identityStoreId,
    owner: { ...state.owner, role: { ...state.owner.role } },
    credential: state.credential,
    passwordChangedAt: state.passwordChangedAt
      ? new Date(state.passwordChangedAt)
      : null,
    tokens: state.tokens.map(cloneToken),
    sessions: state.sessions.map((session) => ({
      ...session,
      refreshTokenHash: Buffer.from(session.refreshTokenHash),
      issuedAt: new Date(session.issuedAt),
      expiresAt: new Date(session.expiresAt),
      revokedAt: session.revokedAt ? new Date(session.revokedAt) : null,
    })),
  };
}

function cloneToken(token: ActivationTokenState): ActivationTokenState {
  return {
    ...token,
    tokenHash: Buffer.from(token.tokenHash),
    expiresAt: new Date(token.expiresAt),
    consumedAt: token.consumedAt ? new Date(token.consumedAt) : null,
    revokedAt: token.revokedAt ? new Date(token.revokedAt) : null,
    createdAt: new Date(token.createdAt),
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: StoreAuthErrorCode,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected tenant Store Owner operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
  }
}
