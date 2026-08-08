import { Logger } from '@nestjs/common';

import { TenantProvisioningStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PostgresTenantProvisionerService } from './services/postgres-tenant-provisioner.service';
import { TenantCredentialEncryptionService } from './services/tenant-credential-encryption.service';
import { TenantIdentityInitializerService } from './services/tenant-identity-initializer.service';
import { TenantMigrationRunnerService } from './services/tenant-migration-runner.service';
import { TenantOwnerInitializerService } from './services/tenant-owner-initializer.service';
import {
  TenantProvisioningConfiguration,
  TenantProvisioningConfigService,
  TenantProvisioningEncryptionKey,
} from './services/tenant-provisioning-config.service';
import {
  createTenantProvisioningError,
  getTenantProvisioningSafeMessage,
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from './tenant-provisioning.errors';
import {
  tenantOwnerBootstrapStoreSelect,
  tenantProvisioningPublicSelect,
} from './tenant-provisioning.select';
import { TenantProvisioningService } from './tenant-provisioning.service';
import * as tenantDatabaseUrlUtils from './utils/tenant-database-url.util';

const storeId = '12345678-1234-4234-8123-456789012345';
const recordId = '98765432-1234-4234-8123-456789012345';
const databaseName = 'tenant_db_12345678123442348123456789012345';
const databaseUser = 'tenant_user_12345678123442348123456789012345';
const encryptedPassword = 'v1:k1:safe-iv:safe-tag:safe-ciphertext';
const plaintextPassword = 'not-returned-plaintext-password';
const ownerName = 'Demo Owner';
const ownerEmail = 'owner@example.com';
const ownerPhone = '+970599000000';
const now = new Date('2026-07-28T12:00:00.000Z');

const configuration: TenantProvisioningConfiguration = {
  postgresAdminUrl: 'postgresql://admin:secret@admin.internal/postgres',
  tenantDatabaseHost: 'tenant-db.internal',
  tenantDatabasePort: 5432,
  tenantDatabaseSslMode: 'require',
  tenantPostgresConnectionTimeoutMs: 10_000,
  tenantMigrationTimeoutMs: 120_000,
  activeEncryptionKeyVersion: 1,
  activeEncryptionKey: new TenantProvisioningEncryptionKey(
    Buffer.alloc(32, 7),
  ),
};

function makeRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: recordId,
    storeId,
    status: TenantProvisioningStatus.PENDING,
    databaseName,
    databaseHost: configuration.tenantDatabaseHost,
    databasePort: configuration.tenantDatabasePort,
    databaseUser,
    databasePasswordEncrypted: encryptedPassword,
    encryptionKeyVersion: 1,
    provisioningStartedAt: null,
    provisionedAt: null,
    failedAt: null,
    lastFailureCode: null,
    lastFailureMessage: null,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeHarness() {
  const prisma = {
    store: {
      findUnique: jest.fn().mockResolvedValue({
        id: storeId,
        ownerName,
        ownerEmail,
        ownerPhone,
      }),
    },
    tenantDatabase: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const config = {
    getProvisioningConfiguration: jest.fn().mockReturnValue(configuration),
  };
  const encryption = {
    generatePassword: jest.fn().mockReturnValue(plaintextPassword),
    encryptPassword: jest.fn().mockReturnValue(encryptedPassword),
    decryptPassword: jest.fn().mockReturnValue(plaintextPassword),
  };
  const postgres = {
    ensureTenantInfrastructure: jest.fn().mockResolvedValue(undefined),
  };
  const migration = {
    runMigrations: jest.fn().mockResolvedValue(undefined),
  };
  const identity = {
    initializeAndVerify: jest.fn().mockResolvedValue(undefined),
  };
  const owner = {
    initialize: jest.fn().mockResolvedValue(undefined),
  };
  const service = new TenantProvisioningService(
    prisma as unknown as PrismaService,
    config as unknown as TenantProvisioningConfigService,
    encryption as unknown as TenantCredentialEncryptionService,
    postgres as unknown as PostgresTenantProvisionerService,
    migration as unknown as TenantMigrationRunnerService,
    identity as unknown as TenantIdentityInitializerService,
    owner as unknown as TenantOwnerInitializerService,
  );

  return {
    service,
    prisma,
    config,
    encryption,
    postgres,
    migration,
    identity,
    owner,
  };
}

function arrangeExistingSuccess(
  harness: ReturnType<typeof makeHarness>,
  initial = makeRecord(),
): void {
  const claimed = makeRecord({
    ...initial,
    status: TenantProvisioningStatus.PROVISIONING,
    attemptCount: Number(initial.attemptCount) + 1,
    provisioningStartedAt: now,
  });
  const ready = makeRecord({
    ...claimed,
    status: TenantProvisioningStatus.READY,
    provisionedAt: now,
  });
  harness.prisma.tenantDatabase.findUnique
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(claimed)
    .mockResolvedValueOnce(ready);
  harness.prisma.tenantDatabase.updateMany
    .mockResolvedValueOnce({ count: 1 })
    .mockResolvedValueOnce({ count: 1 });
}

function expectCode(error: unknown, code: TenantProvisioningErrorCode): void {
  expect(error).toBeInstanceOf(TenantProvisioningError);
  expect((error as TenantProvisioningError).code).toBe(code);
}

describe('TenantProvisioningService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('store lookup and safe reads', () => {
    it('rejects a non-v4 store UUID before querying Prisma', async () => {
      const harness = makeHarness();

      await expect(harness.service.provisionStore('not-a-uuid')).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.IDENTIFIER_INVALID,
      });
      expect(harness.prisma.store.findUnique).not.toHaveBeenCalled();
    });

    it('returns a stable error when the Store does not exist', async () => {
      const harness = makeHarness();
      harness.prisma.store.findUnique.mockResolvedValue(null);

      await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.STORE_NOT_FOUND,
      });
      expect(harness.prisma.store.findUnique).toHaveBeenCalledWith({
        where: { id: storeId },
        select: tenantOwnerBootstrapStoreSelect,
      });
      expect(harness.config.getProvisioningConfiguration).not.toHaveBeenCalled();
    });

    it('gets an existing record with exactly the public projection', async () => {
      const harness = makeHarness();
      const safeRecord = makeRecord({ status: TenantProvisioningStatus.READY });
      delete safeRecord.databaseHost;
      delete safeRecord.databasePort;
      delete safeRecord.databaseUser;
      delete safeRecord.databasePasswordEncrypted;
      delete safeRecord.encryptionKeyVersion;
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(safeRecord);

      const result = await harness.service.getStoreProvisioning(storeId);

      expect(result).toEqual(safeRecord);
      expect(harness.prisma.tenantDatabase.findUnique).toHaveBeenCalledWith({
        where: { storeId },
        select: tenantProvisioningPublicSelect,
      });
      expect(harness.config.getProvisioningConfiguration).not.toHaveBeenCalled();
      expect(Object.keys(result!)).not.toEqual(
        expect.arrayContaining([
          'databaseHost',
          'databasePort',
          'databaseUser',
          'databasePasswordEncrypted',
          'encryptionKeyVersion',
          'tenantDatabaseUrl',
        ]),
      );
    });

    it('returns null when the Store exists without provisioning', async () => {
      const harness = makeHarness();
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(null);

      await expect(
        harness.service.getStoreProvisioning(storeId),
      ).resolves.toBeNull();
      expect(harness.config.getProvisioningConfiguration).not.toHaveBeenCalled();
    });

    it('returns an existing safe provisioning status', async () => {
      const harness = makeHarness();
      const safeRecord = makeRecord({ status: TenantProvisioningStatus.FAILED });
      delete safeRecord.databaseHost;
      delete safeRecord.databasePort;
      delete safeRecord.databaseUser;
      delete safeRecord.databasePasswordEncrypted;
      delete safeRecord.encryptionKeyVersion;
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(safeRecord);

      await expect(
        harness.service.getProvisioningStatus(storeId),
      ).resolves.toEqual(safeRecord);
      expect(harness.prisma.tenantDatabase.findUnique).toHaveBeenCalledWith({
        where: { storeId },
        select: tenantProvisioningPublicSelect,
      });
      expect(JSON.stringify(safeRecord)).not.toMatch(
        /databaseHost|databasePort|databaseUser|databasePasswordEncrypted|encryptionKeyVersion|postgresql:\/\//,
      );
    });

    it('returns STORE_NOT_FOUND when status is requested for a missing Store', async () => {
      const harness = makeHarness();
      harness.prisma.store.findUnique.mockResolvedValue(null);

      await expect(
        harness.service.getProvisioningStatus(storeId),
      ).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.STORE_NOT_FOUND,
        message: 'Store was not found.',
      });
      expect(harness.prisma.tenantDatabase.findUnique).not.toHaveBeenCalled();
    });

    it('returns PROVISIONING_NOT_FOUND when the Store has no provisioning record', async () => {
      const harness = makeHarness();
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(null);

      await expect(
        harness.service.getProvisioningStatus(storeId),
      ).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.PROVISIONING_NOT_FOUND,
        message: 'Tenant provisioning record was not found.',
      });
    });
  });

  describe('new records', () => {
    it('validates configuration before creating or attempting provisioning', async () => {
      const harness = makeHarness();
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(null);
      harness.config.getProvisioningConfiguration.mockImplementation(() => {
        throw new TenantProvisioningError(
          TenantProvisioningErrorCode.CONFIGURATION_INVALID,
          'unsafe raw configuration details',
        );
      });

      await expect(harness.service.provisionStore(storeId)).rejects.toEqual(
        expect.objectContaining({
          code: TenantProvisioningErrorCode.CONFIGURATION_INVALID,
          message: 'Tenant provisioning configuration is invalid.',
        }),
      );
      expect(harness.prisma.tenantDatabase.create).not.toHaveBeenCalled();
      expect(harness.prisma.tenantDatabase.updateMany).not.toHaveBeenCalled();
      expect(harness.postgres.ensureTenantInfrastructure).not.toHaveBeenCalled();
    });

    it.each([
      TenantProvisioningStatus.PENDING,
      TenantProvisioningStatus.FAILED,
    ])(
      'does not claim or increment %s when configuration validation fails',
      async (status) => {
        const harness = makeHarness();
        harness.prisma.tenantDatabase.findUnique.mockResolvedValue(
          makeRecord({ status, attemptCount: 2 }),
        );
        harness.config.getProvisioningConfiguration.mockImplementation(() => {
          throw createTenantProvisioningError(
            TenantProvisioningErrorCode.CONFIGURATION_INVALID,
          );
        });

        await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
          code: TenantProvisioningErrorCode.CONFIGURATION_INVALID,
        });
        expect(harness.prisma.tenantDatabase.updateMany).not.toHaveBeenCalled();
        expect(harness.encryption.decryptPassword).not.toHaveBeenCalled();
        expect(harness.postgres.ensureTenantInfrastructure).not.toHaveBeenCalled();
      },
    );

    it('persists a complete PENDING record before adapters and encrypts exact context', async () => {
      const harness = makeHarness();
      const pending = makeRecord();
      const claimed = makeRecord({
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: 1,
      });
      const ready = makeRecord({
        status: TenantProvisioningStatus.READY,
        attemptCount: 1,
        provisionedAt: now,
      });
      harness.prisma.tenantDatabase.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(claimed)
        .mockResolvedValueOnce(ready);
      harness.prisma.tenantDatabase.create.mockResolvedValue(pending);
      harness.prisma.tenantDatabase.updateMany.mockResolvedValue({ count: 1 });

      const result = await harness.service.provisionStore(storeId);
      const createData = harness.prisma.tenantDatabase.create.mock.calls[0][0].data;

      expect(createData).toEqual({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        storeId,
        status: TenantProvisioningStatus.PENDING,
        databaseName,
        databaseHost: configuration.tenantDatabaseHost,
        databasePort: configuration.tenantDatabasePort,
        databaseUser,
        databasePasswordEncrypted: encryptedPassword,
        encryptionKeyVersion: 1,
        attemptCount: 0,
      });
      expect(createData).not.toEqual(
        expect.objectContaining({ databasePasswordEncrypted: plaintextPassword }),
      );
      expect(harness.encryption.generatePassword).toHaveBeenCalledTimes(1);
      expect(harness.encryption.encryptPassword).toHaveBeenCalledWith(
        plaintextPassword,
        {
          tenantDatabaseRecordId: createData.id,
          storeId,
          databaseName,
          databaseUser,
          keyVersion: 1,
        },
        expect.any(Buffer),
      );
      expect(
        harness.prisma.tenantDatabase.create.mock.invocationCallOrder[0],
      ).toBeLessThan(
        harness.postgres.ensureTenantInfrastructure.mock.invocationCallOrder[0],
      );
      expect(JSON.stringify(result)).not.toContain(plaintextPassword);
      expect(JSON.stringify(result)).not.toContain(encryptedPassword);
    });
  });

  describe('existing states and claims', () => {
    it('returns READY without requesting unavailable configuration or side effects', async () => {
      const harness = makeHarness();
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(
        makeRecord({ status: TenantProvisioningStatus.READY }),
      );
      harness.config.getProvisioningConfiguration.mockImplementation(() => {
        throw new Error('configuration must not be requested');
      });

      const result = await harness.service.provisionStore(storeId);

      expect(result.alreadyReady).toBe(true);
      expect(harness.config.getProvisioningConfiguration).not.toHaveBeenCalled();
      expect(harness.encryption.generatePassword).not.toHaveBeenCalled();
      expect(harness.encryption.encryptPassword).not.toHaveBeenCalled();
      expect(harness.encryption.decryptPassword).not.toHaveBeenCalled();
      expect(harness.prisma.tenantDatabase.updateMany).not.toHaveBeenCalled();
      expect(harness.postgres.ensureTenantInfrastructure).not.toHaveBeenCalled();
      expect(harness.owner.initialize).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(encryptedPassword);
    });

    it('rejects PROVISIONING without requesting unavailable configuration or side effects', async () => {
      const harness = makeHarness();
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(
        makeRecord({ status: TenantProvisioningStatus.PROVISIONING }),
      );
      harness.config.getProvisioningConfiguration.mockImplementation(() => {
        throw new Error('configuration must not be requested');
      });

      await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.PROVISIONING_IN_PROGRESS,
      });
      expect(harness.config.getProvisioningConfiguration).not.toHaveBeenCalled();
      expect(harness.encryption.generatePassword).not.toHaveBeenCalled();
      expect(harness.encryption.encryptPassword).not.toHaveBeenCalled();
      expect(harness.encryption.decryptPassword).not.toHaveBeenCalled();
      expect(harness.prisma.tenantDatabase.updateMany).not.toHaveBeenCalled();
      expect(harness.postgres.ensureTenantInfrastructure).not.toHaveBeenCalled();
    });

    it.each([
      TenantProvisioningStatus.PENDING,
      TenantProvisioningStatus.FAILED,
    ])('claims and completes an existing %s record', async (status) => {
      const harness = makeHarness();
      arrangeExistingSuccess(harness, makeRecord({ status, attemptCount: 2 }));

      const result = await harness.service.provisionStore(storeId);

      expect(result.alreadyReady).toBe(false);
      expect(harness.prisma.tenantDatabase.updateMany.mock.calls[0][0]).toEqual({
        where: {
          id: recordId,
          status: {
            in: [
              TenantProvisioningStatus.PENDING,
              TenantProvisioningStatus.FAILED,
            ],
          },
        },
        data: {
          status: TenantProvisioningStatus.PROVISIONING,
          attemptCount: { increment: 1 },
          provisioningStartedAt: expect.any(Date),
          provisionedAt: null,
          failedAt: null,
          lastFailureCode: null,
          lastFailureMessage: null,
        },
      });
    });

    it('retries FAILED with the original credential and generates no password', async () => {
      const harness = makeHarness();
      arrangeExistingSuccess(
        harness,
        makeRecord({ status: TenantProvisioningStatus.FAILED, attemptCount: 1 }),
      );

      await harness.service.provisionStore(storeId);

      expect(harness.encryption.generatePassword).not.toHaveBeenCalled();
      expect(harness.encryption.decryptPassword).toHaveBeenCalledWith(
        encryptedPassword,
        1,
        {
          tenantDatabaseRecordId: recordId,
          storeId,
          databaseName,
          databaseUser,
          keyVersion: 1,
        },
        expect.any(Buffer),
      );
      expect(harness.prisma.tenantDatabase.updateMany.mock.calls).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              databasePasswordEncrypted: expect.anything(),
            }),
          }),
        ]),
      );
    });

    it.each([
      [TenantProvisioningStatus.READY, undefined],
      [
        TenantProvisioningStatus.PROVISIONING,
        TenantProvisioningErrorCode.PROVISIONING_IN_PROGRESS,
      ],
      [
        TenantProvisioningStatus.FAILED,
        TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
      ],
    ])('handles claim loss followed by %s', async (status, expectedCode) => {
      const harness = makeHarness();
      harness.prisma.tenantDatabase.findUnique
        .mockResolvedValueOnce(makeRecord())
        .mockResolvedValueOnce(makeRecord({ status }));
      harness.prisma.tenantDatabase.updateMany.mockResolvedValue({ count: 0 });

      if (expectedCode) {
        await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
          code: expectedCode,
        });
      } else {
        await expect(harness.service.provisionStore(storeId)).resolves.toMatchObject({
          alreadyReady: true,
        });
      }
      expect(harness.postgres.ensureTenantInfrastructure).not.toHaveBeenCalled();
    });

    it.each([
      ['missing record', null],
      [
        'wrong status',
        makeRecord({
          status: TenantProvisioningStatus.PENDING,
          attemptCount: 1,
        }),
      ],
      [
        'unchanged attempt count',
        makeRecord({
          status: TenantProvisioningStatus.PROVISIONING,
          attemptCount: 0,
        }),
      ],
      [
        'attempt count incremented by more than one',
        makeRecord({
          status: TenantProvisioningStatus.PROVISIONING,
          attemptCount: 2,
        }),
      ],
      [
        'mismatched Store id',
        makeRecord({
          storeId: '22222222-2222-4222-8222-222222222222',
          status: TenantProvisioningStatus.PROVISIONING,
          attemptCount: 1,
        }),
      ],
      [
        'mismatched record id',
        makeRecord({
          id: '33333333-3333-4333-8333-333333333333',
          status: TenantProvisioningStatus.PROVISIONING,
          attemptCount: 1,
        }),
      ],
    ])(
      'fails closed without writing FAILED when the claim re-read has %s',
      async (_label, claimedRecord) => {
        const harness = makeHarness();
        harness.prisma.tenantDatabase.findUnique
          .mockResolvedValueOnce(makeRecord())
          .mockResolvedValueOnce(claimedRecord);
        harness.prisma.tenantDatabase.updateMany.mockResolvedValue({ count: 1 });

        await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
          code: TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
        });
        expect(harness.prisma.tenantDatabase.updateMany).toHaveBeenCalledTimes(1);
        expect(harness.encryption.decryptPassword).not.toHaveBeenCalled();
        expect(harness.postgres.ensureTenantInfrastructure).not.toHaveBeenCalled();
        expect(harness.migration.runMigrations).not.toHaveBeenCalled();
        expect(harness.identity.initializeAndVerify).not.toHaveBeenCalled();
      },
    );
  });

  describe('concurrent creation', () => {
    it('continues with the same-store record after P2002', async () => {
      const harness = makeHarness();
      const raced = makeRecord();
      const claimed = makeRecord({
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: 1,
      });
      const ready = makeRecord({
        status: TenantProvisioningStatus.READY,
        attemptCount: 1,
      });
      harness.prisma.tenantDatabase.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(raced)
        .mockResolvedValueOnce(claimed)
        .mockResolvedValueOnce(ready);
      harness.prisma.tenantDatabase.create.mockRejectedValue({ code: 'P2002' });
      harness.prisma.tenantDatabase.updateMany.mockResolvedValue({ count: 1 });

      await expect(harness.service.provisionStore(storeId)).resolves.toMatchObject({
        alreadyReady: false,
      });
      expect(harness.prisma.tenantDatabase.findFirst).not.toHaveBeenCalled();
    });

    it.each(['databaseName', 'databaseUser'])(
      'fails closed when P2002 %s belongs to another store',
      async () => {
        const harness = makeHarness();
        harness.prisma.tenantDatabase.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null);
        harness.prisma.tenantDatabase.create.mockRejectedValue({
          code: 'P2002',
          meta: { target: 'must-not-leak' },
        });
        harness.prisma.tenantDatabase.findFirst.mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          storeId: '22222222-2222-4222-8222-222222222222',
        });

        let caught: unknown;
        try {
          await harness.service.provisionStore(storeId);
        } catch (error) {
          caught = error;
        }

        expectCode(caught, TenantProvisioningErrorCode.IDENTIFIER_CONFLICT);
        expect((caught as Error).message).not.toContain('must-not-leak');
        expect(harness.prisma.tenantDatabase.findFirst).toHaveBeenCalledWith({
          where: { OR: [{ databaseName }, { databaseUser }] },
          select: { id: true, storeId: true },
        });
        expect(harness.prisma.tenantDatabase.updateMany).not.toHaveBeenCalled();
      },
    );

    it('maps unrelated P2002 without an identifier owner to the generic error', async () => {
      const harness = makeHarness();
      harness.prisma.tenantDatabase.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      harness.prisma.tenantDatabase.create.mockRejectedValue({
        code: 'P2002',
        message: 'raw unrelated constraint detail',
      });
      harness.prisma.tenantDatabase.findFirst.mockResolvedValue(null);

      await expect(harness.service.provisionStore(storeId)).rejects.toEqual(
        expect.objectContaining({
          code: TenantProvisioningErrorCode.PROVISIONING_FAILED,
          message: getTenantProvisioningSafeMessage(
            TenantProvisioningErrorCode.PROVISIONING_FAILED,
          ),
        }),
      );
      expect(harness.prisma.tenantDatabase.updateMany).not.toHaveBeenCalled();
    });

    it('maps a P2003 race to Store not found when the Store was deleted', async () => {
      const harness = makeHarness();
      harness.prisma.store.findUnique
        .mockResolvedValueOnce({ id: storeId })
        .mockResolvedValueOnce(null);
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(null);
      harness.prisma.tenantDatabase.create.mockRejectedValue({
        code: 'P2003',
        meta: { field_name: 'must-not-leak' },
      });

      await expect(harness.service.provisionStore(storeId)).rejects.toEqual(
        expect.objectContaining({
          code: TenantProvisioningErrorCode.STORE_NOT_FOUND,
          message: getTenantProvisioningSafeMessage(
            TenantProvisioningErrorCode.STORE_NOT_FOUND,
          ),
        }),
      );
      expect(harness.prisma.store.findUnique).toHaveBeenLastCalledWith({
        where: { id: storeId },
        select: { id: true },
      });
      expect(harness.postgres.ensureTenantInfrastructure).not.toHaveBeenCalled();
    });

    it('maps a P2003 race to generic failure when the Store still exists', async () => {
      const harness = makeHarness();
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(null);
      harness.prisma.tenantDatabase.create.mockRejectedValue({
        code: 'P2003',
        message: 'raw foreign key detail',
      });

      await expect(harness.service.provisionStore(storeId)).rejects.toEqual(
        expect.objectContaining({
          code: TenantProvisioningErrorCode.PROVISIONING_FAILED,
          message: getTenantProvisioningSafeMessage(
            TenantProvisioningErrorCode.PROVISIONING_FAILED,
          ),
        }),
      );
      expect(harness.prisma.store.findUnique).toHaveBeenCalledTimes(2);
      expect(harness.postgres.ensureTenantInfrastructure).not.toHaveBeenCalled();
    });
  });

  describe('record integrity', () => {
    it.each([
      ['database name', { databaseName: 'tenant_db_wrong' }],
      ['database user', { databaseUser: 'tenant_user_wrong' }],
      ['missing host', { databaseHost: null }],
      ['missing port', { databasePort: null }],
      ['invalid port', { databasePort: 65_536 }],
      ['missing encrypted password', { databasePasswordEncrypted: null }],
      ['missing key version', { encryptionKeyVersion: null }],
      ['invalid key version', { encryptionKeyVersion: 0 }],
    ])('rejects %s without repairing or claiming', async (_label, change) => {
      const harness = makeHarness();
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(
        makeRecord(change),
      );

      await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.RECORD_INTEGRITY_FAILED,
      });
      expect(harness.prisma.tenantDatabase.updateMany).not.toHaveBeenCalled();
      expect(harness.prisma.tenantDatabase.create).not.toHaveBeenCalled();
    });

    it.each([
      ['host', { databaseHost: 'other.internal' }],
      ['port', { databasePort: 5433 }],
    ])('rejects configured %s drift without claiming', async (_label, change) => {
      const harness = makeHarness();
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(
        makeRecord(change),
      );

      await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.CONFIGURATION_DRIFT,
      });
      expect(harness.prisma.tenantDatabase.updateMany).not.toHaveBeenCalled();
    });

    it('normalizes equivalent loopback hosts for drift comparison', async () => {
      const harness = makeHarness();
      harness.config.getProvisioningConfiguration.mockReturnValue({
        ...configuration,
        tenantDatabaseHost: 'localhost',
      });
      arrangeExistingSuccess(harness, makeRecord({ databaseHost: '[::1]' }));

      await expect(harness.service.provisionStore(storeId)).resolves.toMatchObject({
        alreadyReady: false,
      });
    });

    it.each([
      ['tenant.example.com', 'TENANT.EXAMPLE.COM.'],
      ['tenant.region.example.com', 'TENANT.REGION.EXAMPLE.COM.'],
      ['localhost.', '127.0.0.25'],
      ['127.42.0.1', 'LOCALHOST.'],
      ['[::1]', '0:0:0:0:0:0:0:1'],
    ])(
      'allows equivalent normalized host %s and configured host %s',
      async (storedHost, configuredHost) => {
        const harness = makeHarness();
        harness.config.getProvisioningConfiguration.mockReturnValue({
          ...configuration,
          tenantDatabaseHost: configuredHost,
        });
        arrangeExistingSuccess(
          harness,
          makeRecord({ databaseHost: storedHost }),
        );

        await expect(harness.service.provisionStore(storeId)).resolves.toMatchObject({
          alreadyReady: false,
        });
      },
    );

    it.each([
      '127.attacker.example',
      '127.attacker.example.',
      '127.Attacker.Example',
      '127.0.example',
    ])(
      'does not treat DNS hostname %s as configured localhost',
      async (databaseHost) => {
        const harness = makeHarness();
        harness.config.getProvisioningConfiguration.mockReturnValue({
          ...configuration,
          tenantDatabaseHost: 'localhost',
        });
        harness.prisma.tenantDatabase.findUnique.mockResolvedValue(
          makeRecord({ databaseHost }),
        );

        await expect(
          harness.service.provisionStore(storeId),
        ).rejects.toMatchObject({
          code: TenantProvisioningErrorCode.CONFIGURATION_DRIFT,
        });
        expect(harness.prisma.tenantDatabase.updateMany).not.toHaveBeenCalled();
      },
    );

    it('fails safely when host normalization becomes empty', async () => {
      const harness = makeHarness();
      harness.config.getProvisioningConfiguration.mockReturnValue({
        ...configuration,
        tenantDatabaseHost: '.',
      });
      harness.prisma.tenantDatabase.findUnique.mockResolvedValue(
        makeRecord({ databaseHost: '.' }),
      );

      await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.RECORD_INTEGRITY_FAILED,
      });
      expect(harness.prisma.tenantDatabase.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('saga and fencing', () => {
    it('runs adapters in order with canonical values and an in-memory URL', async () => {
      const harness = makeHarness();
      const urlSpy = jest.spyOn(
        tenantDatabaseUrlUtils,
        'buildTenantDatabaseUrl',
      );
      arrangeExistingSuccess(harness);

      const result = await harness.service.provisionStore(storeId);
      const tenantUrl = harness.migration.runMigrations.mock.calls[0][0]
        .tenantDatabaseUrl as string;

      expect(harness.postgres.ensureTenantInfrastructure).toHaveBeenCalledWith({
        postgresAdminUrl: configuration.postgresAdminUrl,
        storeId,
        databaseName,
        databaseUser,
        plaintextPassword,
        connectionTimeoutMs: configuration.tenantPostgresConnectionTimeoutMs,
      });
      expect(tenantUrl).toContain('tenant-db.internal');
      expect(tenantUrl).toContain(encodeURIComponent(databaseName));
      expect(harness.identity.initializeAndVerify).toHaveBeenCalledWith({
        tenantDatabaseUrl: tenantUrl,
        storeId,
        connectionTimeoutMs: configuration.tenantPostgresConnectionTimeoutMs,
      });
      expect(harness.prisma.store.findUnique).toHaveBeenCalledWith({
        where: { id: storeId },
        select: tenantOwnerBootstrapStoreSelect,
      });
      expect(harness.owner.initialize).toHaveBeenCalledWith({
        tenantDatabaseUrl: tenantUrl,
        storeId,
        fullName: ownerName,
        email: ownerEmail,
        phone: ownerPhone,
        connectionTimeoutMs: configuration.tenantPostgresConnectionTimeoutMs,
      });
      expect(
        harness.encryption.decryptPassword.mock.invocationCallOrder[0],
      ).toBeLessThan(
        harness.postgres.ensureTenantInfrastructure.mock.invocationCallOrder[0],
      );
      expect(
        harness.postgres.ensureTenantInfrastructure.mock.invocationCallOrder[0],
      ).toBeLessThan(urlSpy.mock.invocationCallOrder[0]);
      expect(urlSpy.mock.invocationCallOrder[0]).toBeLessThan(
        harness.migration.runMigrations.mock.invocationCallOrder[0],
      );
      expect(
        harness.migration.runMigrations.mock.invocationCallOrder[0],
      ).toBeLessThan(
        harness.identity.initializeAndVerify.mock.invocationCallOrder[0],
      );
      expect(
        harness.identity.initializeAndVerify.mock.invocationCallOrder[0],
      ).toBeLessThan(
        harness.owner.initialize.mock.invocationCallOrder[0],
      );
      expect(
        harness.owner.initialize.mock.invocationCallOrder[0],
      ).toBeLessThan(
        harness.prisma.tenantDatabase.updateMany.mock.invocationCallOrder[1],
      );
      expect(harness.prisma.tenantDatabase.updateMany.mock.calls[1][0]).toEqual({
        where: {
          id: recordId,
          status: TenantProvisioningStatus.PROVISIONING,
          attemptCount: 1,
        },
        data: {
          status: TenantProvisioningStatus.READY,
          provisionedAt: expect.any(Date),
          failedAt: null,
          lastFailureCode: null,
          lastFailureMessage: null,
        },
      });
      expect(Object.keys(result.provisioning)).not.toEqual(
        expect.arrayContaining([
          'databaseHost',
          'databasePort',
          'databaseUser',
          'databasePasswordEncrypted',
          'encryptionKeyVersion',
        ]),
      );
      const serializedResult = JSON.stringify(result);
      expect(serializedResult).not.toContain(tenantUrl);
      expect(serializedResult).not.toContain(plaintextPassword);
      expect(serializedResult).not.toContain(configuration.postgresAdminUrl);
      expect(serializedResult).not.toContain(ownerEmail);
      expect(serializedResult).not.toContain(ownerPhone);
    });

    it('forwards a nullable owner phone without changing it', async () => {
      const harness = makeHarness();
      harness.prisma.store.findUnique.mockResolvedValue({
        id: storeId,
        ownerName,
        ownerEmail,
        ownerPhone: null,
      });
      arrangeExistingSuccess(harness);

      await harness.service.provisionStore(storeId);

      expect(harness.owner.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ phone: null }),
      );
    });

    it('fails safely when the fenced READY update loses ownership', async () => {
      const harness = makeHarness();
      const claimed = makeRecord({
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: 1,
      });
      harness.prisma.tenantDatabase.findUnique
        .mockResolvedValueOnce(makeRecord())
        .mockResolvedValueOnce(claimed);
      harness.prisma.tenantDatabase.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });

      await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
      });
      expect(harness.owner.initialize).toHaveBeenCalledTimes(1);
      expect(harness.prisma.tenantDatabase.updateMany.mock.calls[2][0].where).toEqual({
        id: recordId,
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: 1,
      });
    });

    it('retries idempotent owner initialization after READY persistence fails', async () => {
      const harness = makeHarness();
      const pending = makeRecord();
      const claimedFirst = makeRecord({
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: 1,
      });
      const failed = makeRecord({
        status: TenantProvisioningStatus.FAILED,
        attemptCount: 1,
        lastFailureCode: TenantProvisioningErrorCode.PROVISIONING_FAILED,
        lastFailureMessage: getTenantProvisioningSafeMessage(
          TenantProvisioningErrorCode.PROVISIONING_FAILED,
        ),
      });
      const claimedRetry = makeRecord({
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: 2,
      });
      const ready = makeRecord({
        status: TenantProvisioningStatus.READY,
        attemptCount: 2,
        provisionedAt: now,
      });
      harness.prisma.tenantDatabase.findUnique
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(claimedFirst)
        .mockResolvedValueOnce(failed)
        .mockResolvedValueOnce(claimedRetry)
        .mockResolvedValueOnce(ready);
      harness.prisma.tenantDatabase.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error('raw READY persistence detail'))
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });

      await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.PROVISIONING_FAILED,
      });
      await expect(harness.service.provisionStore(storeId)).resolves.toMatchObject({
        alreadyReady: false,
        provisioning: {
          status: TenantProvisioningStatus.READY,
          attemptCount: 2,
        },
      });

      expect(harness.owner.initialize).toHaveBeenCalledTimes(2);
      expect(harness.encryption.generatePassword).not.toHaveBeenCalled();
    });

    it('retries a FAILED owner initialization and reaches READY', async () => {
      const harness = makeHarness();
      const pending = makeRecord();
      const claimedFirst = makeRecord({
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: 1,
      });
      const failed = makeRecord({
        status: TenantProvisioningStatus.FAILED,
        attemptCount: 1,
        lastFailureCode:
          TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
        lastFailureMessage: getTenantProvisioningSafeMessage(
          TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
        ),
      });
      const claimedRetry = makeRecord({
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: 2,
      });
      const ready = makeRecord({
        status: TenantProvisioningStatus.READY,
        attemptCount: 2,
        provisionedAt: now,
      });
      harness.prisma.tenantDatabase.findUnique
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(claimedFirst)
        .mockResolvedValueOnce(failed)
        .mockResolvedValueOnce(claimedRetry)
        .mockResolvedValueOnce(ready);
      harness.prisma.tenantDatabase.updateMany.mockResolvedValue({ count: 1 });
      harness.owner.initialize
        .mockRejectedValueOnce(
          new TenantProvisioningError(
            TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
            `raw:${ownerName}:${ownerEmail}:${ownerPhone}`,
          ),
        )
        .mockResolvedValueOnce(undefined);

      await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
        message: getTenantProvisioningSafeMessage(
          TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
        ),
      });
      await expect(harness.service.provisionStore(storeId)).resolves.toMatchObject({
        alreadyReady: false,
        provisioning: { status: TenantProvisioningStatus.READY },
      });

      expect(harness.owner.initialize).toHaveBeenCalledTimes(2);
    });
  });

  describe('failure persistence and sanitization', () => {
    it.each([
      [
        'decryption',
        'decryptPassword',
        TenantProvisioningErrorCode.CREDENTIAL_DECRYPTION_FAILED,
      ],
      [
        'PostgreSQL administration',
        'ensureTenantInfrastructure',
        TenantProvisioningErrorCode.POSTGRES_ADMIN_UNAVAILABLE,
      ],
      [
        'PostgreSQL role conflict',
        'ensureTenantInfrastructure',
        TenantProvisioningErrorCode.ROLE_CONFLICT,
      ],
      [
        'PostgreSQL role provisioning',
        'ensureTenantInfrastructure',
        TenantProvisioningErrorCode.ROLE_PROVISIONING_FAILED,
      ],
      [
        'PostgreSQL database owner conflict',
        'ensureTenantInfrastructure',
        TenantProvisioningErrorCode.DATABASE_OWNER_CONFLICT,
      ],
      [
        'PostgreSQL database provisioning',
        'ensureTenantInfrastructure',
        TenantProvisioningErrorCode.DATABASE_PROVISIONING_FAILED,
      ],
      ['migration', 'runMigrations', TenantProvisioningErrorCode.MIGRATION_FAILED],
      [
        'identity',
        'initializeAndVerify',
        TenantProvisioningErrorCode.IDENTITY_MISMATCH,
      ],
      [
        'identity initialization',
        'initializeAndVerify',
        TenantProvisioningErrorCode.IDENTITY_INITIALIZATION_FAILED,
      ],
      [
        'identity verification',
        'initializeAndVerify',
        TenantProvisioningErrorCode.VERIFICATION_FAILED,
      ],
      [
        'identity cleanup',
        'initializeAndVerify',
        TenantProvisioningErrorCode.IDENTITY_CLEANUP_FAILED,
      ],
      [
        'owner conflict',
        'initializeOwner',
        TenantProvisioningErrorCode.OWNER_CONFLICT,
      ],
      [
        'owner initialization',
        'initializeOwner',
        TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
      ],
      [
        'owner cleanup',
        'initializeOwner',
        TenantProvisioningErrorCode.OWNER_CLEANUP_FAILED,
      ],
    ])(
      'persists a sanitized fenced FAILED state for %s failure',
      async (_label, method, code) => {
        const harness = makeHarness();
        const claimed = makeRecord({
          status: TenantProvisioningStatus.PROVISIONING,
          attemptCount: 1,
        });
        harness.prisma.tenantDatabase.findUnique
          .mockResolvedValueOnce(makeRecord())
          .mockResolvedValueOnce(claimed);
        harness.prisma.tenantDatabase.updateMany.mockResolvedValue({ count: 1 });
        const urlSpy = jest.spyOn(
          tenantDatabaseUrlUtils,
          'buildTenantDatabaseUrl',
        );
        const raw = `raw:${plaintextPassword}:${encryptedPassword}:${configuration.postgresAdminUrl}:${ownerName}:${ownerEmail}:${ownerPhone}`;
        const failure = new TenantProvisioningError(code, raw);

        if (method === 'decryptPassword') {
          harness.encryption.decryptPassword.mockImplementation(() => {
            throw failure;
          });
        } else if (method === 'ensureTenantInfrastructure') {
          harness.postgres.ensureTenantInfrastructure.mockRejectedValue(failure);
        } else if (method === 'runMigrations') {
          harness.migration.runMigrations.mockRejectedValue(failure);
        } else if (method === 'initializeOwner') {
          harness.owner.initialize.mockRejectedValue(failure);
        } else {
          harness.identity.initializeAndVerify.mockRejectedValue(failure);
        }

        let caught: unknown;
        try {
          await harness.service.provisionStore(storeId);
        } catch (error) {
          caught = error;
        }

        expectCode(caught, code);
        expect((caught as Error).message).toBe(
          getTenantProvisioningSafeMessage(code),
        );
        const failedUpdate =
          harness.prisma.tenantDatabase.updateMany.mock.calls.at(-1)![0];
        expect(failedUpdate.where).toEqual({
          id: recordId,
          status: TenantProvisioningStatus.PROVISIONING,
          attemptCount: 1,
        });
        expect(failedUpdate.data).toEqual({
          status: TenantProvisioningStatus.FAILED,
          failedAt: expect.any(Date),
          provisionedAt: null,
          lastFailureCode: code,
          lastFailureMessage: getTenantProvisioningSafeMessage(code),
        });
        expect(JSON.stringify(caught)).not.toContain(plaintextPassword);
        expect((caught as Error).message).not.toContain(encryptedPassword);
        expect((caught as Error).message).not.toContain('postgresql://');
        expect((caught as Error).message).not.toContain(ownerEmail);
        expect(JSON.stringify(failedUpdate)).not.toContain(ownerName);
        expect(JSON.stringify(failedUpdate)).not.toContain(ownerEmail);
        expect(JSON.stringify(failedUpdate)).not.toContain(ownerPhone);
        if (method === 'ensureTenantInfrastructure') {
          expect(urlSpy).not.toHaveBeenCalled();
          expect(harness.migration.runMigrations).not.toHaveBeenCalled();
          expect(harness.identity.initializeAndVerify).not.toHaveBeenCalled();
          expect(harness.owner.initialize).not.toHaveBeenCalled();
        } else if (method === 'runMigrations') {
          expect(harness.identity.initializeAndVerify).not.toHaveBeenCalled();
          expect(harness.owner.initialize).not.toHaveBeenCalled();
        } else if (method === 'initializeAndVerify') {
          expect(harness.owner.initialize).not.toHaveBeenCalled();
        }
        expect(
          harness.prisma.tenantDatabase.updateMany.mock.calls.some(
            ([options]) =>
              options.data.status === TenantProvisioningStatus.READY,
          ),
        ).toBe(false);
      },
    );

    it.each([
      TenantProvisioningStatus.PENDING,
      TenantProvisioningStatus.FAILED,
    ])(
      'claims %s with an unsupported stored key version and persists safe failure',
      async (status) => {
        const harness = makeHarness();
        const unsupportedPayload = 'v1:k2:safe-iv:safe-tag:safe-ciphertext';
        const initial = makeRecord({
          status,
          encryptionKeyVersion: 2,
          databasePasswordEncrypted: unsupportedPayload,
          attemptCount: 3,
        });
        const claimed = makeRecord({
          ...initial,
          status: TenantProvisioningStatus.PROVISIONING,
          attemptCount: 4,
        });
        harness.prisma.tenantDatabase.findUnique
          .mockResolvedValueOnce(initial)
          .mockResolvedValueOnce(claimed);
        harness.prisma.tenantDatabase.updateMany.mockResolvedValue({ count: 1 });
        harness.encryption.decryptPassword.mockImplementation(() => {
          throw createTenantProvisioningError(
            TenantProvisioningErrorCode.CREDENTIAL_DECRYPTION_FAILED,
          );
        });

        await expect(harness.service.provisionStore(storeId)).rejects.toEqual(
          expect.objectContaining({
            code: TenantProvisioningErrorCode.CREDENTIAL_DECRYPTION_FAILED,
            message: getTenantProvisioningSafeMessage(
              TenantProvisioningErrorCode.CREDENTIAL_DECRYPTION_FAILED,
            ),
          }),
        );
        expect(harness.encryption.generatePassword).not.toHaveBeenCalled();
        expect(harness.encryption.decryptPassword).toHaveBeenCalledWith(
          unsupportedPayload,
          2,
          expect.objectContaining({ keyVersion: 2 }),
          expect.any(Buffer),
        );
        const failedUpdate =
          harness.prisma.tenantDatabase.updateMany.mock.calls[1][0];
        expect(failedUpdate).toEqual({
          where: {
            id: recordId,
            status: TenantProvisioningStatus.PROVISIONING,
            attemptCount: 4,
          },
          data: {
            status: TenantProvisioningStatus.FAILED,
            failedAt: expect.any(Date),
            provisionedAt: null,
            lastFailureCode:
              TenantProvisioningErrorCode.CREDENTIAL_DECRYPTION_FAILED,
            lastFailureMessage: getTenantProvisioningSafeMessage(
              TenantProvisioningErrorCode.CREDENTIAL_DECRYPTION_FAILED,
            ),
          },
        });
        expect(JSON.stringify(failedUpdate)).not.toContain(unsupportedPayload);
        expect(harness.postgres.ensureTenantInfrastructure).not.toHaveBeenCalled();
        expect(harness.migration.runMigrations).not.toHaveBeenCalled();
      },
    );

    it('maps unknown failures to the static generic code and message', async () => {
      const harness = makeHarness();
      arrangeExistingSuccess(harness);
      harness.postgres.ensureTenantInfrastructure.mockRejectedValue(
        new Error(`Prisma P9999 migration stderr ${plaintextPassword}`),
      );

      await expect(harness.service.provisionStore(storeId)).rejects.toEqual(
        expect.objectContaining({
          code: TenantProvisioningErrorCode.PROVISIONING_FAILED,
          message: 'Tenant database provisioning failed.',
        }),
      );
      const failedUpdate =
        harness.prisma.tenantDatabase.updateMany.mock.calls.at(-1)![0];
      expect(failedUpdate.data.lastFailureMessage).toBe(
        'Tenant database provisioning failed.',
      );
    });

    it('never logs secrets or raw infrastructure details on failure', async () => {
      const loggerSpies = [
        jest.spyOn(Logger.prototype, 'log').mockImplementation(),
        jest.spyOn(Logger.prototype, 'error').mockImplementation(),
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(),
      ];
      const consoleSpies = [
        jest.spyOn(console, 'log').mockImplementation(),
        jest.spyOn(console, 'error').mockImplementation(),
        jest.spyOn(console, 'warn').mockImplementation(),
        jest.spyOn(console, 'debug').mockImplementation(),
      ];
      const harness = makeHarness();
      arrangeExistingSuccess(harness);
      const tenantUrl =
        'postgresql://tenant:tenant-password@tenant.internal/tenant_database';
      const rawDetails = [
        plaintextPassword,
        encryptedPassword,
        tenantUrl,
        configuration.postgresAdminUrl,
        Buffer.alloc(32, 7).toString('base64url'),
        'Prisma P2003 constraint detail',
        'PostgreSQL role detail',
        'migration stderr output',
      ].join('|');
      harness.postgres.ensureTenantInfrastructure.mockRejectedValue(
        new Error(rawDetails),
      );

      let caught: unknown;
      try {
        await harness.service.provisionStore(storeId);
      } catch (error) {
        caught = error;
      }

      expect((caught as TenantProvisioningError).code).toBe(
        TenantProvisioningErrorCode.PROVISIONING_FAILED,
      );
      expect(JSON.stringify(caught)).not.toContain(rawDetails);
      expect(harness.service).not.toHaveProperty('logger');
      for (const spy of [...loggerSpies, ...consoleSpies]) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it('preserves the original error when failure persistence loses its fence', async () => {
      const harness = makeHarness();
      const claimed = makeRecord({
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: 1,
      });
      harness.prisma.tenantDatabase.findUnique
        .mockResolvedValueOnce(makeRecord())
        .mockResolvedValueOnce(claimed);
      harness.prisma.tenantDatabase.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      harness.migration.runMigrations.mockRejectedValue(
        new TenantProvisioningError(
          TenantProvisioningErrorCode.MIGRATION_FAILED,
          'unsafe output',
        ),
      );

      await expect(harness.service.provisionStore(storeId)).rejects.toEqual(
        expect.objectContaining({
          code: TenantProvisioningErrorCode.MIGRATION_FAILED,
          message: 'Tenant database migration failed.',
        }),
      );
    });

    it('preserves the original error when failure persistence itself rejects', async () => {
      const harness = makeHarness();
      const claimed = makeRecord({
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: 1,
      });
      harness.prisma.tenantDatabase.findUnique
        .mockResolvedValueOnce(makeRecord())
        .mockResolvedValueOnce(claimed);
      harness.prisma.tenantDatabase.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error('raw Prisma update detail'));
      harness.migration.runMigrations.mockRejectedValue(
        new TenantProvisioningError(
          TenantProvisioningErrorCode.MIGRATION_FAILED,
          'unsafe output',
        ),
      );

      await expect(harness.service.provisionStore(storeId)).rejects.toEqual(
        expect.objectContaining({
          code: TenantProvisioningErrorCode.MIGRATION_FAILED,
          message: 'Tenant database migration failed.',
        }),
      );
    });

    it('sanitizes tenant URL construction failure and performs no cleanup', async () => {
      const harness = makeHarness();
      arrangeExistingSuccess(harness);
      harness.encryption.decryptPassword.mockReturnValue('');

      await expect(harness.service.provisionStore(storeId)).rejects.toMatchObject({
        code: TenantProvisioningErrorCode.DATABASE_URL_INVALID,
      });
      expect(harness.migration.runMigrations).not.toHaveBeenCalled();
      expect(harness.identity.initializeAndVerify).not.toHaveBeenCalled();
      expect(harness.owner.initialize).not.toHaveBeenCalled();
    });
  });
});
