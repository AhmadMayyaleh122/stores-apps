import { PrismaPg } from '@prisma/adapter-pg';

import { TenantProvisioningStatus } from '../../../../generated/prisma/client';
import { PrismaClient as TenantPrismaClient } from '../../../../generated/tenant-prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { TenantCredentialEncryptionService } from '../../tenant-provisioning/services/tenant-credential-encryption.service';
import {
  TenantProvisioningConfigService,
  TenantProvisioningEncryptionKey,
} from '../../tenant-provisioning/services/tenant-provisioning-config.service';
import {
  createStoreAuthError,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';
import { StoreTenantAccessService } from './store-tenant-access.service';

jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: jest.fn() }));
jest.mock('../../../../generated/tenant-prisma/client', () => {
  const actual = jest.requireActual(
    '../../../../generated/tenant-prisma/client',
  );

  return { ...actual, PrismaClient: jest.fn() };
});

describe('StoreTenantAccessService', () => {
  const storeId = '12345678-1234-4234-8123-456789012345';
  const otherStoreId = '87654321-4321-4321-8123-456789012345';
  const tenantDatabaseId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const databaseName = 'tenant_db_12345678123442348123456789012345';
  const databaseUser = 'tenant_user_12345678123442348123456789012345';
  const databasePassword = 'owner@access:/% password';
  const encryptionKey = Buffer.alloc(32, 29);
  const storeSlug = 'demo-store';
  let service: StoreTenantAccessService;
  let masterFindUnique: jest.Mock;
  let getTenantAccessConfiguration: jest.Mock;
  let tenantIdentityFindUnique: jest.Mock;
  let disconnect: jest.Mock;
  let tenantClient: {
    _originalClient: {
      _engineConfig: {
        adapter: { config: { connectionString: string } };
      };
    };
    tenantIdentity: { findUnique: jest.Mock };
    employee: { findUnique: jest.Mock };
    $connect: jest.Mock;
    $disconnect: jest.Mock;
    $queryRaw: jest.Mock;
    $queryRawUnsafe: jest.Mock;
    $executeRaw: jest.Mock;
    $executeRawUnsafe: jest.Mock;
    $extends: jest.Mock;
  };
  let credentialEncryptionService: TenantCredentialEncryptionService;
  let readyStore: ReturnType<typeof buildReadyStore>;

  beforeEach(() => {
    (PrismaPg as unknown as jest.Mock).mockReset();
    (TenantPrismaClient as unknown as jest.Mock).mockReset();
    masterFindUnique = jest.fn();
    getTenantAccessConfiguration = jest.fn().mockReturnValue(
      Object.freeze({
        tenantDatabaseHost: 'db.example.test',
        tenantDatabasePort: 5432,
        tenantDatabaseSslMode: 'verify-full',
        tenantPostgresConnectionTimeoutMs: 4_000,
        encryptionKeyVersion: 1,
        encryptionKey: new TenantProvisioningEncryptionKey(encryptionKey),
      }),
    );
    tenantIdentityFindUnique = jest.fn().mockResolvedValue({
      id: 1,
      masterStoreId: storeId,
    });
    disconnect = jest.fn().mockResolvedValue(undefined);
    tenantClient = {
      _originalClient: {
        _engineConfig: {
          adapter: {
            config: {
              connectionString: `postgresql://tenant:${databasePassword}@db.example.test/${databaseName}`,
            },
          },
        },
      },
      tenantIdentity: { findUnique: tenantIdentityFindUnique },
      employee: { findUnique: jest.fn() },
      $connect: jest.fn(),
      $disconnect: disconnect,
      $queryRaw: jest.fn(),
      $queryRawUnsafe: jest.fn(),
      $executeRaw: jest.fn(),
      $executeRawUnsafe: jest.fn(),
      $extends: jest.fn(),
    };
    (PrismaPg as unknown as jest.Mock).mockReturnValue({ adapter: true });
    (TenantPrismaClient as unknown as jest.Mock).mockReturnValue(tenantClient);
    credentialEncryptionService = new TenantCredentialEncryptionService();
    readyStore = buildReadyStore(
      credentialEncryptionService.encryptPassword(
        databasePassword,
        encryptionContext(),
        encryptionKey,
      ),
    );
    masterFindUnique.mockResolvedValue(readyStore);
    service = new StoreTenantAccessService(
      {
        store: { findUnique: masterFindUnique },
      } as unknown as PrismaService,
      {
        getTenantAccessConfiguration,
      } as unknown as TenantProvisioningConfigService,
      credentialEncryptionService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('store slug validation and Master lookup', () => {
    it('accepts a valid canonical slug and performs an exact unique lookup', async () => {
      await expect(
        service.withResolvedTenant(storeSlug, () => 'resolved'),
      ).resolves.toBe('resolved');

      expect(masterFindUnique).toHaveBeenCalledWith({
        where: { storeSlug: 'demo-store' },
        select: expectedMasterSelect(),
      });
    });

    it.each([
      ['uppercase', 'Demo-store'],
      ['leading whitespace', ' demo-store'],
      ['trailing whitespace', 'demo-store '],
      ['invalid characters', 'demo_store'],
      ['too short', 'a'],
      ['too long', 'a'.repeat(81)],
      ['non-string', 1234],
    ])('rejects %s input before Master lookup', async (_label, value) => {
      await expectCode(
        service.withResolvedTenant(value, () => undefined),
        StoreAuthErrorCode.STORE_SLUG_INVALID,
      );
      expect(masterFindUnique).not.toHaveBeenCalled();
      expect(PrismaPg).not.toHaveBeenCalled();
    });

    it('does not expose a rejected slug', async () => {
      const rejectedSlug = 'Secret Store';

      try {
        await service.withResolvedTenant(rejectedSlug, () => undefined);
        throw new Error('Expected slug validation to fail');
      } catch (error) {
        expect((error as Error).message).toBe('Store identifier is invalid.');
        expect((error as Error).message).not.toContain(rejectedSlug);
      }
    });

    it('uses only the canonical TenantDatabase relation and required fields', async () => {
      await service.withResolvedTenant(storeSlug, () => undefined);

      const query = masterFindUnique.mock.calls[0][0];
      const serializedSelect = JSON.stringify(query.select);

      expect(query.select).toEqual(expectedMasterSelect());
      expect(serializedSelect).not.toContain('ownerName');
      expect(serializedSelect).not.toContain('ownerEmail');
      expect(serializedSelect).not.toContain('ownerPhone');
      expect(serializedSelect).not.toContain('subscription');
      expect(query.select).not.toHaveProperty('databaseName');
      expect(query.select).not.toHaveProperty('databaseHost');
      expect(query.select).not.toHaveProperty('databaseUser');
      expect(query.select).not.toHaveProperty('databasePasswordEncrypted');
    });

    it('maps an unknown store to a safe unavailable error', async () => {
      masterFindUnique.mockResolvedValue(null);

      await expectCode(
        service.withResolvedTenant(storeSlug, () => undefined),
        StoreAuthErrorCode.TENANT_UNAVAILABLE,
      );
      expect(PrismaPg).not.toHaveBeenCalled();
    });

    it('maps a Master query failure to a safe access error', async () => {
      masterFindUnique.mockRejectedValue(
        new Error('Master SQL detail for demo-store'),
      );

      await expectSafeFailure(
        service.withResolvedTenant(storeSlug, () => undefined),
        StoreAuthErrorCode.TENANT_ACCESS_FAILED,
        ['Master SQL detail', storeSlug],
      );
    });
  });

  describe('tenant state and metadata', () => {
    it('accepts only READY tenant state', async () => {
      await expect(
        service.withResolvedTenant(storeSlug, () => 'ready'),
      ).resolves.toBe('ready');
      expect(PrismaPg).toHaveBeenCalledTimes(1);
    });

    it('rejects a missing canonical TenantDatabase relation', async () => {
      masterFindUnique.mockResolvedValue({ ...readyStore, tenantDatabase: null });

      await expectUnavailableBeforeConstruction();
    });

    it.each([
      TenantProvisioningStatus.PENDING,
      TenantProvisioningStatus.PROVISIONING,
      TenantProvisioningStatus.FAILED,
    ])('rejects %s state before configuration or construction', async (status) => {
      masterFindUnique.mockResolvedValue({
        ...readyStore,
        tenantDatabase: { ...readyStore.tenantDatabase, status },
      });

      await expectUnavailableBeforeConstruction();
    });

    it.each([
      ['mismatched relation Store ID', { storeId: otherStoreId }],
      ['invalid relation ID', { id: 'not-a-uuid' }],
      ['missing host', { databaseHost: null }],
      ['invalid port', { databasePort: 0 }],
      ['missing user', { databaseUser: null }],
      ['missing credential', { databasePasswordEncrypted: null }],
      ['missing key version', { encryptionKeyVersion: null }],
    ])('rejects %s before constructing a client', async (_label, overrides) => {
      masterFindUnique.mockResolvedValue({
        ...readyStore,
        tenantDatabase: { ...readyStore.tenantDatabase, ...overrides },
      });

      await expectCode(
        service.withResolvedTenant(storeSlug, () => undefined),
        StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
      );
      expect(PrismaPg).not.toHaveBeenCalled();
    });

    it('rejects a stored slug inconsistent with the unique lookup', async () => {
      masterFindUnique.mockResolvedValue({
        ...readyStore,
        storeSlug: 'different-store',
      });

      await expectCode(
        service.withResolvedTenant(storeSlug, () => undefined),
        StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
      );
    });

    it.each([
      ['different host', { tenantDatabaseHost: 'other.example.test' }],
      ['different port', { tenantDatabasePort: 5440 }],
    ])('rejects runtime/stored %s drift', async (_label, overrides) => {
      getTenantAccessConfiguration.mockReturnValue({
        ...getTenantAccessConfiguration(),
        ...overrides,
      });
      getTenantAccessConfiguration.mockClear();

      await expectCode(
        service.withResolvedTenant(storeSlug, () => undefined),
        StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
      );
      expect(PrismaPg).not.toHaveBeenCalled();
    });

    it('uses trusted runtime host after provisioning-compatible consistency validation', async () => {
      readyStore.tenantDatabase.databaseHost = 'DB.EXAMPLE.TEST.';

      await expect(
        service.withResolvedTenant(storeSlug, () => 'normalized'),
      ).resolves.toBe('normalized');

      const connectionString = (PrismaPg as unknown as jest.Mock).mock.calls[0][0]
        .connectionString as string;
      expect(new URL(connectionString).hostname).toBe('db.example.test');
    });

    it.each([
      '127.attacker.example',
      '127.attacker.example.',
      '127.Attacker.Example',
      '127.0.example',
    ])('does not treat unsafe DNS hostname %s as runtime loopback', async (hostname) => {
      readyStore.tenantDatabase.databaseHost = hostname;
      getTenantAccessConfiguration.mockReturnValue({
        ...getTenantAccessConfiguration(),
        tenantDatabaseHost: 'localhost',
      });
      getTenantAccessConfiguration.mockClear();

      await expectCode(
        service.withResolvedTenant(storeSlug, () => undefined),
        StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
      );
      expect(PrismaPg).not.toHaveBeenCalled();
    });
  });

  describe('credential and URL resolution', () => {
    it('resolves the exact stored encryption key version', async () => {
      await service.withResolvedTenant(storeSlug, () => undefined);

      expect(getTenantAccessConfiguration).toHaveBeenCalledWith(1);
    });

    it('maps unsupported key configuration safely', async () => {
      getTenantAccessConfiguration.mockImplementation(() => {
        throw new Error('unsupported key version 99 with secret material');
      });

      await expectSafeFailure(
        service.withResolvedTenant(storeSlug, () => undefined),
        StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
        ['99', 'secret material'],
      );
      expect(PrismaPg).not.toHaveBeenCalled();
    });

    it('rejects a malformed authenticated credential safely', async () => {
      readyStore.tenantDatabase.databasePasswordEncrypted =
        'v1:k1:not-valid:credential:material';

      await expectSafeFailure(
        service.withResolvedTenant(storeSlug, () => undefined),
        StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
        ['not-valid', 'credential'],
      );
      expect(PrismaPg).not.toHaveBeenCalled();
    });

    it('maps decryption failure without exposing credential material', async () => {
      const ciphertext = readyStore.tenantDatabase.databasePasswordEncrypted;
      jest
        .spyOn(credentialEncryptionService, 'decryptPassword')
        .mockImplementation(() => {
          throw new Error(`decrypt failed for ${ciphertext}`);
        });

      await expectSafeFailure(
        service.withResolvedTenant(storeSlug, () => undefined),
        StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
        [ciphertext, databasePassword],
      );
    });

    it('fails safely when a valid ciphertext is decrypted with the wrong stored-version key', async () => {
      const ciphertext = readyStore.tenantDatabase.databasePasswordEncrypted;
      const wrongKey = Buffer.alloc(32, 91);
      const encodedWrongKey = wrongKey.toString('base64url');
      getTenantAccessConfiguration.mockReturnValue({
        ...getTenantAccessConfiguration(),
        encryptionKey: new TenantProvisioningEncryptionKey(wrongKey),
      });
      getTenantAccessConfiguration.mockClear();

      await expectSafeFailure(
        service.withResolvedTenant(storeSlug, () => undefined),
        StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
        [ciphertext, databasePassword, encodedWrongKey],
      );
      expect(PrismaPg).not.toHaveBeenCalled();
    });

    it('builds a parseable URL without double encoding special characters', async () => {
      await service.withResolvedTenant(storeSlug, () => undefined);

      const adapterOptions = (PrismaPg as unknown as jest.Mock).mock.calls[0][0];
      const parsed = new URL(adapterOptions.connectionString);

      expect(decodeWhatwgComponent(parsed.username)).toBe(databaseUser);
      expect(decodeWhatwgComponent(parsed.password)).toBe(databasePassword);
      expect(decodeWhatwgComponent(parsed.pathname.slice(1))).toBe(
        databaseName,
      );
      expect(parsed.hostname).toBe('db.example.test');
      expect(parsed.port).toBe('5432');
      expect(parsed.searchParams.get('sslmode')).toBe('verify-full');
    });

    it('constructs connection values only from stored and runtime configuration', async () => {
      await service.withResolvedTenant(storeSlug, () => undefined);

      const connectionString = (PrismaPg as unknown as jest.Mock).mock.calls[0][0]
        .connectionString as string;
      expect(connectionString).not.toContain(storeSlug);
      expect(new URL(connectionString).hostname).toBe('db.example.test');
    });
  });

  describe('connection and callback lifecycle', () => {
    it('uses a bounded single-connection tenant client', async () => {
      await service.withResolvedTenant(storeSlug, () => undefined);

      expect(PrismaPg).toHaveBeenCalledWith({
        connectionString: expect.any(String),
        max: 1,
        connectionTimeoutMillis: 4_000,
      });
      expect(TenantPrismaClient).toHaveBeenCalledWith({
        adapter: { adapter: true },
      });
    });

    it.each(['adapter', 'client'] as const)(
      'does not disconnect after %s construction failure',
      async (failurePoint) => {
        if (failurePoint === 'adapter') {
          (PrismaPg as unknown as jest.Mock).mockImplementationOnce(() => {
            throw new Error('adapter secret detail');
          });
        } else {
          (TenantPrismaClient as unknown as jest.Mock).mockImplementationOnce(
            () => {
              throw new Error('client secret detail');
            },
          );
        }

        await expectCode(
          service.withResolvedTenant(storeSlug, () => undefined),
          StoreAuthErrorCode.TENANT_ACCESS_FAILED,
        );
        expect(disconnect).not.toHaveBeenCalled();
      },
    );

    it('disconnects after a successful operation and passes its result through', async () => {
      await expect(
        service.withResolvedTenant(storeSlug, () => ({ activated: false })),
      ).resolves.toEqual({ activated: false });
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('provides only the verified Store ID and opaque Store Auth access capability', async () => {
      await service.withResolvedTenant(storeSlug, (context) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.keys(context).sort()).toEqual([
          'storeId',
          'tenantAccess',
        ]);
        expect(context.storeId).toBe(storeId);
        expect(context.tenantAccess).toMatchObject({
          kind: 'STORE_AUTH_TENANT_ACCESS',
          checkOwnerActivationEligibility: expect.any(Function),
          issueOwnerActivation: expect.any(Function),
          activateOwner: expect.any(Function),
        });
        expect(Object.keys(context.tenantAccess).sort()).toEqual([
          'activateOwner',
          'checkOwnerActivationEligibility',
          'issueOwnerActivation',
          'kind',
        ]);
        expect(Object.isFrozen(context.tenantAccess)).toBe(true);
        expect(Object.getPrototypeOf(context.tenantAccess)).toBeNull();
        expect(context).not.toHaveProperty('tenantDatabaseUrl');
        expect(context).not.toHaveProperty('password');
        expect(context).not.toHaveProperty('databaseHost');
        expect(context).not.toHaveProperty('databaseUser');
      });
    });

    it('does not expose Prisma, connection secrets, raw SQL, or lifecycle controls at runtime', async () => {
      await service.withResolvedTenant(storeSlug, (context) => {
        const inspection = inspectCallbackVisibleValues(
          context,
          tenantClient,
          databasePassword,
        );

        expect(inspection).toEqual({
          callbackCanReachConnectionString: false,
          callbackCanReachPassword: false,
          callbackCanReachRawPrismaClient: false,
          callbackCanControlConnectionLifecycle: false,
          callbackCanExecuteRawSql: false,
          callbackCanReachPrismaInternals: false,
        });
      });
    });

    it('sanitizes synchronous callback failures and disconnects', async () => {
      await expectSafeFailure(
        service.withResolvedTenant(storeSlug, () => {
          throw new Error(`operation exposed ${databasePassword}`);
        }),
        StoreAuthErrorCode.TENANT_ACCESS_FAILED,
        [databasePassword],
      );
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('sanitizes asynchronous callback failures and disconnects', async () => {
      await expectCode(
        service.withResolvedTenant(storeSlug, async () => {
          throw new Error('async Prisma detail');
        }),
        StoreAuthErrorCode.TENANT_ACCESS_FAILED,
      );
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('preserves the code but restores the static safe callback message', async () => {
      const unsafeCustomError = new StoreAuthError(
        StoreAuthErrorCode.ACTIVATION_TOKEN_INVALID,
        `unsafe callback detail ${databasePassword}`,
      );

      await expectSafeFailure(
        service.withResolvedTenant(storeSlug, () => {
          throw unsafeCustomError;
        }),
        StoreAuthErrorCode.ACTIVATION_TOKEN_INVALID,
        [databasePassword, 'unsafe callback detail'],
      );
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('maps an unknown Store Auth error code to the static access failure', async () => {
      const unsafeError = new StoreAuthError(
        'STORE_AUTH_UNEXPECTED_RUNTIME_CODE' as StoreAuthErrorCode,
        `unsafe unknown-code detail ${databasePassword}`,
      );

      await expectSafeFailure(
        service.withResolvedTenant(storeSlug, () => {
          throw unsafeError;
        }),
        StoreAuthErrorCode.TENANT_ACCESS_FAILED,
        [databasePassword, 'unsafe unknown-code detail'],
      );
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('preserves the primary failure when disconnect also fails', async () => {
      disconnect.mockRejectedValue(new Error('cleanup topology detail'));

      await expectCode(
        service.withResolvedTenant(storeSlug, () => {
          throw createStoreAuthError(
            StoreAuthErrorCode.ACTIVATION_TOKEN_INVALID,
          );
        }),
        StoreAuthErrorCode.ACTIVATION_TOKEN_INVALID,
      );
    });

    it('maps cleanup failure after success to a safe cleanup error', async () => {
      disconnect.mockRejectedValue(
        new Error(`cleanup failed for ${databasePassword}`),
      );

      await expectSafeFailure(
        service.withResolvedTenant(storeSlug, () => 'success'),
        StoreAuthErrorCode.TENANT_CLEANUP_FAILED,
        [databasePassword],
      );
    });
  });

  describe('TenantIdentity boundary', () => {
    it('verifies the singleton identity before invoking the operation', async () => {
      const events: string[] = [];
      tenantIdentityFindUnique.mockImplementation(async () => {
        events.push('identity');
        return { id: 1, masterStoreId: storeId };
      });

      await service.withResolvedTenant(storeSlug, () => {
        events.push('operation');
      });

      expect(tenantIdentityFindUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        select: { id: true, masterStoreId: true },
      });
      expect(events).toEqual(['identity', 'operation']);
    });

    it('accepts canonical UUID comparison with different letter casing', async () => {
      const mixedCaseStoreId = 'ABCDEF12-1234-4ABC-8DEF-ABCDEF123456';
      const encryptedPassword = credentialEncryptionService.encryptPassword(
        databasePassword,
        {
          ...encryptionContext(),
          storeId: mixedCaseStoreId,
        },
        encryptionKey,
      );
      readyStore = {
        ...buildReadyStore(encryptedPassword),
        id: mixedCaseStoreId,
        tenantDatabase: {
          ...buildReadyStore(encryptedPassword).tenantDatabase,
          storeId: mixedCaseStoreId,
        },
      };
      masterFindUnique.mockResolvedValue(readyStore);
      tenantIdentityFindUnique.mockResolvedValue({
        id: 1,
        masterStoreId: mixedCaseStoreId.toLowerCase(),
      });

      await expect(
        service.withResolvedTenant(storeSlug, () => 'verified'),
      ).resolves.toBe('verified');
    });

    it.each([
      ['missing singleton', null],
      ['wrong singleton ID', { id: 2, masterStoreId: storeId }],
      ['mismatched Store ID', { id: 1, masterStoreId: otherStoreId }],
      ['invalid stored UUID', { id: 1, masterStoreId: 'not-a-uuid' }],
    ])('rejects %s before invoking the operation', async (_label, identity) => {
      tenantIdentityFindUnique.mockResolvedValue(identity);
      const operation = jest.fn();

      await expectCode(
        service.withResolvedTenant(storeSlug, operation),
        StoreAuthErrorCode.TENANT_IDENTITY_INVALID,
      );
      expect(operation).not.toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('maps an identity query failure to a safe access error', async () => {
      tenantIdentityFindUnique.mockRejectedValue(
        new Error(`SELECT failed at ${databaseName} with ${databasePassword}`),
      );
      const operation = jest.fn();

      await expectSafeFailure(
        service.withResolvedTenant(storeSlug, operation),
        StoreAuthErrorCode.TENANT_ACCESS_FAILED,
        [databaseName, databasePassword, 'SELECT'],
      );
      expect(operation).not.toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalledTimes(1);
    });
  });

  function buildReadyStore(encryptedPassword: string) {
    return {
      id: storeId,
      storeSlug,
      tenantDatabase: {
        id: tenantDatabaseId,
        storeId,
        status: TenantProvisioningStatus.READY,
        databaseName,
        databaseHost: 'db.example.test',
        databasePort: 5432,
        databaseUser,
        databasePasswordEncrypted: encryptedPassword,
        encryptionKeyVersion: 1,
      },
    };
  }

  function encryptionContext() {
    return {
      tenantDatabaseRecordId: tenantDatabaseId,
      storeId,
      databaseName,
      databaseUser,
      keyVersion: 1,
    };
  }

  function expectedMasterSelect() {
    return {
      id: true,
      storeSlug: true,
      tenantDatabase: {
        select: {
          id: true,
          storeId: true,
          status: true,
          databaseName: true,
          databaseHost: true,
          databasePort: true,
          databaseUser: true,
          databasePasswordEncrypted: true,
          encryptionKeyVersion: true,
        },
      },
    };
  }

  async function expectUnavailableBeforeConstruction(): Promise<void> {
    await expectCode(
      service.withResolvedTenant(storeSlug, () => undefined),
      StoreAuthErrorCode.TENANT_UNAVAILABLE,
    );
    expect(getTenantAccessConfiguration).not.toHaveBeenCalled();
    expect(PrismaPg).not.toHaveBeenCalled();
  }
});

async function expectCode(
  promise: Promise<unknown>,
  code: StoreAuthErrorCode,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected Store Auth operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
  }
}

async function expectSafeFailure(
  promise: Promise<unknown>,
  code: StoreAuthErrorCode,
  forbiddenValues: string[],
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected Store Auth operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
    for (const forbiddenValue of forbiddenValues) {
      expect((error as Error).message).not.toContain(forbiddenValue);
    }
  }
}

function decodeWhatwgComponent(value: string): string {
  return decodeURIComponent(value.replace(/%(?![0-9a-f]{2})/gi, '%25'));
}

function inspectCallbackVisibleValues(
  callbackContext: unknown,
  rawPrismaClient: object,
  password: string,
): {
  callbackCanReachConnectionString: boolean;
  callbackCanReachPassword: boolean;
  callbackCanReachRawPrismaClient: boolean;
  callbackCanControlConnectionLifecycle: boolean;
  callbackCanExecuteRawSql: boolean;
  callbackCanReachPrismaInternals: boolean;
} {
  const seen = new Set<object>();
  const propertyNames = new Set<string>();
  let callbackCanReachConnectionString = false;
  let callbackCanReachPassword = false;
  let callbackCanReachRawPrismaClient = false;

  function inspect(value: unknown): void {
    if (typeof value === 'string') {
      callbackCanReachConnectionString ||= value.startsWith('postgresql://');
      callbackCanReachPassword ||= value.includes(password);
      return;
    }

    if (
      (typeof value !== 'object' && typeof value !== 'function') ||
      value === null ||
      seen.has(value)
    ) {
      return;
    }

    if (value === rawPrismaClient) {
      callbackCanReachRawPrismaClient = true;
    }

    seen.add(value);
    for (const propertyKey of Reflect.ownKeys(value)) {
      propertyNames.add(String(propertyKey));

      try {
        inspect(Reflect.get(value, propertyKey));
      } catch {
        // An inaccessible reflected property cannot expose a callback value.
      }
    }
  }

  inspect(callbackContext);

  return {
    callbackCanReachConnectionString,
    callbackCanReachPassword,
    callbackCanReachRawPrismaClient,
    callbackCanControlConnectionLifecycle: [
      '$connect',
      '$disconnect',
      '$extends',
    ].some((propertyName) => propertyNames.has(propertyName)),
    callbackCanExecuteRawSql: [
      '$queryRaw',
      '$queryRawUnsafe',
      '$executeRaw',
      '$executeRawUnsafe',
    ].some((propertyName) => propertyNames.has(propertyName)),
    callbackCanReachPrismaInternals: [
      '_originalClient',
      '_engineConfig',
      'adapter',
      'config',
      'connectionString',
    ].some((propertyName) => propertyNames.has(propertyName)),
  };
}
