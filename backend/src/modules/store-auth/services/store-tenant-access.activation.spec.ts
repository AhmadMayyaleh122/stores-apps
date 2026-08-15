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
          events.push('lock-owner');
          lockQueryText = queryText;
          lockQueryValues = values;
          return draft.owner.isStoreOwner ? [{ id: draft.owner.id }] : [];
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
}

interface TransactionHooks {
  tokenCreateError?: unknown;
  credentialError?: unknown;
  statusError?: unknown;
  tokenFenceCount?: number;
  statusFenceCount?: number;
  advisoryClockTime?: Date;
  transactionClockTime?: Date;
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
