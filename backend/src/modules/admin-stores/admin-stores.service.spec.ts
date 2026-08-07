import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  BillingInterval,
  BillingType,
  Prisma,
  StoreStatus,
  SubscriptionStatus,
  TenantProvisioningStatus,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  createTenantProvisioningError,
  getTenantProvisioningSafeMessage,
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning/tenant-provisioning.errors';
import { TenantProvisioningService } from '../tenant-provisioning/tenant-provisioning.service';
import { AdminStoresService } from './admin-stores.service';
import { CreateAdminStoreDto } from './dto/create-admin-store.dto';
import { ListAdminStoresQueryDto } from './dto/list-admin-stores-query.dto';
import { UpdateAdminStoreDto } from './dto/update-admin-store.dto';

type MockPrismaStore = {
  findFirst: jest.Mock;
  create: jest.Mock;
  findMany: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
};

describe('AdminStoresService', () => {
  let service: AdminStoresService;
  let store: MockPrismaStore;
  let tenantProvisioning: {
    provisionStore: jest.Mock;
    getProvisioningStatus: jest.Mock;
  };

  const now = new Date('2026-07-06T10:00:00.000Z');

  const baseStore = {
    id: '4de3dc53-bceb-44e1-b94d-aab4f9a7b197',
    storeName: 'Demo Store',
    storeSlug: 'demo-store',
    ownerName: 'Demo Owner',
    ownerEmail: 'owner@example.com',
    ownerPhone: '+970599000000',
    status: StoreStatus.TRIAL,
    subscriptionPlanId: null,
    databaseName: null,
    logoUrl: null,
    primaryColor: null,
    secondaryColor: null,
    createdAt: now,
    updatedAt: now,
  };

  const provisioning = {
    id: '98765432-1234-4234-8123-456789012345',
    storeId: baseStore.id,
    status: TenantProvisioningStatus.READY,
    databaseName: 'tenant_db_4de3dc53bceb44e1b94daab4f9a7b197',
    attemptCount: 1,
    provisioningStartedAt: now,
    provisionedAt: now,
    failedAt: null,
    lastFailureCode: null,
    lastFailureMessage: null,
    createdAt: now,
    updatedAt: now,
  };

  beforeEach(() => {
    store = {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    };
    tenantProvisioning = {
      provisionStore: jest.fn().mockResolvedValue({
        provisioning,
        alreadyReady: false,
      }),
      getProvisioningStatus: jest.fn().mockResolvedValue(provisioning),
    };

    service = new AdminStoresService(
      { store } as unknown as PrismaService,
      tenantProvisioning as unknown as TenantProvisioningService,
    );
  });

  function createDto(
    overrides: Partial<CreateAdminStoreDto> = {},
  ): CreateAdminStoreDto {
    return {
      storeName: 'Demo Store',
      storeSlug: 'demo-store',
      ownerName: 'Demo Owner',
      ownerEmail: 'owner@example.com',
      ownerPhone: '+970599000000',
      ...overrides,
    };
  }

  function createPrismaKnownRequestError(
    code: string,
    meta?: Record<string, unknown>,
  ): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Prisma error', {
      code,
      clientVersion: 'test',
      meta,
    });
  }

  it('creates a store successfully', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);

    const response = await service.createStore(createDto());

    expect(response).toEqual({
      success: true,
      message: 'Store created successfully',
      data: {
        store: baseStore,
      },
    });
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeName: 'Demo Store',
          storeSlug: 'demo-store',
          ownerEmail: 'owner@example.com',
        }),
      }),
    );
    expect(tenantProvisioning.provisionStore).toHaveBeenCalledTimes(1);
    expect(tenantProvisioning.provisionStore).toHaveBeenCalledWith(
      baseStore.id,
    );
    expect(store.create.mock.invocationCallOrder[0]).toBeLessThan(
      tenantProvisioning.provisionStore.mock.invocationCallOrder[0],
    );
  });

  it('waits for provisioning to reach READY before returning create success', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);
    let resolveProvisioning!: (value: {
      provisioning: typeof provisioning;
      alreadyReady: boolean;
    }) => void;
    tenantProvisioning.provisionStore.mockReturnValue(
      new Promise((resolve) => {
        resolveProvisioning = resolve;
      }),
    );
    let settled = false;

    const responsePromise = service.createStore(createDto());
    void responsePromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(tenantProvisioning.provisionStore).toHaveBeenCalledWith(
      baseStore.id,
    );
    expect(settled).toBe(false);

    resolveProvisioning({ provisioning, alreadyReady: false });

    await expect(responsePromise).resolves.toMatchObject({
      success: true,
      message: 'Store created successfully',
    });
  });

  it('treats an already READY provisioning result as successful creation', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);
    tenantProvisioning.provisionStore.mockResolvedValue({
      provisioning,
      alreadyReady: true,
    });

    await expect(service.createStore(createDto())).resolves.toMatchObject({
      success: true,
      data: { store: baseStore },
    });
  });

  it.each([false, true])(
    'rejects a non-READY provisioning result when alreadyReady is %s',
    async (alreadyReady) => {
      store.findFirst.mockResolvedValue(null);
      store.create.mockResolvedValue(baseStore);
      tenantProvisioning.provisionStore.mockResolvedValue({
        provisioning: {
          ...provisioning,
          status: TenantProvisioningStatus.FAILED,
        },
        alreadyReady,
      });

      await expect(service.createStore(createDto())).rejects.toMatchObject({
        response: {
          success: false,
          message: 'Tenant provisioning state changed concurrently.',
          code: TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
        },
      });
    },
  );

  it('maps a malformed provisioning result to a generic internal error', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);
    tenantProvisioning.provisionStore.mockResolvedValue(undefined);

    let caught: unknown;
    try {
      await service.createStore(createDto());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect((caught as HttpException).getResponse()).toEqual({
      success: false,
      message: 'Tenant database provisioning failed.',
      code: TenantProvisioningErrorCode.PROVISIONING_FAILED,
    });
    expect(JSON.stringify(caught)).not.toContain('Cannot read');
  });

  it('maps an unknown provisioning failure without exposing its raw message', async () => {
    const rawMessage =
      'raw Prisma detail postgresql://admin:secret@localhost/postgres';
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);
    tenantProvisioning.provisionStore.mockRejectedValue(new Error(rawMessage));

    let caught: unknown;
    try {
      await service.createStore(createDto());
    } catch (error) {
      caught = error;
    }

    expect((caught as HttpException).getStatus()).toBe(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect((caught as HttpException).getResponse()).toEqual({
      success: false,
      message: 'Tenant database provisioning failed.',
      code: TenantProvisioningErrorCode.PROVISIONING_FAILED,
    });
    expect(JSON.stringify(caught)).not.toContain(rawMessage);
  });

  it('does not start provisioning when Master Store creation fails', async () => {
    const masterFailure = new Error('master create failed');
    store.findFirst.mockResolvedValue(null);
    store.create.mockRejectedValue(masterFailure);

    await expect(service.createStore(createDto())).rejects.toBe(masterFailure);
    expect(tenantProvisioning.provisionStore).not.toHaveBeenCalled();
  });

  it('fails Store creation safely when provisioning fails', async () => {
    const rawDetails =
      'postgresql://admin:raw-password@localhost/postgres encrypted-secret';
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);
    tenantProvisioning.provisionStore.mockRejectedValue(
      Object.assign(
        createTenantProvisioningError(
          TenantProvisioningErrorCode.DATABASE_PROVISIONING_FAILED,
        ),
        { rawDetails },
      ),
    );

    let caught: unknown;
    try {
      await service.createStore(createDto());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect(caught).toMatchObject({
      response: {
        success: false,
        message: 'Tenant database could not be provisioned.',
        code: TenantProvisioningErrorCode.DATABASE_PROVISIONING_FAILED,
      },
    });
    expect(JSON.stringify(caught)).not.toContain(rawDetails);
    expect(JSON.stringify(caught)).not.toContain('Store created successfully');
    expect(store.create).toHaveBeenCalledTimes(1);
  });

  it('does not include provisioning secrets in the Store create response', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);
    tenantProvisioning.provisionStore.mockResolvedValue({
      provisioning: {
        ...provisioning,
        databasePasswordEncrypted: 'encrypted-secret',
        tenantDatabaseUrl:
          'postgresql://tenant:plaintext-password@tenant.internal/database',
      },
      alreadyReady: false,
    });

    const response = await service.createStore(createDto());
    const serialized = JSON.stringify(response);

    expect(serialized).not.toContain('encrypted-secret');
    expect(serialized).not.toContain('plaintext-password');
    expect(serialized).not.toContain('postgresql://');
  });

  it('defaults status to TRIAL when status is not provided', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);

    await service.createStore(createDto({ status: undefined }));

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: StoreStatus.TRIAL,
        }),
      }),
    );
  });

  it('normalizes storeSlug to lowercase', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);

    await service.createStore(createDto({ storeSlug: 'DEMO-STORE' }));

    expect(store.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ storeSlug: 'demo-store' }]),
        }),
      }),
    );
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeSlug: 'demo-store',
        }),
      }),
    );
  });

  it('throws ConflictException when storeSlug already exists', async () => {
    store.findFirst.mockResolvedValue({
      storeSlug: 'demo-store',
      databaseName: null,
    });

    await expect(service.createStore(createDto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(store.create).not.toHaveBeenCalled();
    expect(tenantProvisioning.provisionStore).not.toHaveBeenCalled();
  });

  it('translates Prisma P2002 storeSlug races to ConflictException', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockRejectedValue(
      createPrismaKnownRequestError('P2002', {
        target: ['storeSlug'],
      }),
    );

    await expect(service.createStore(createDto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tenantProvisioning.provisionStore).not.toHaveBeenCalled();
  });

  it('translates Prisma P2002 databaseName races to ConflictException', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockRejectedValue(
      createPrismaKnownRequestError('P2002', {
        target: ['database_name'],
      }),
    );

    await expect(
      service.createStore(createDto({ databaseName: 'demo_store' })),
    ).rejects.toMatchObject({
      response: {
        success: false,
        message: 'Store database name already exists',
      },
    });
  });

  it('does not select sensitive database password fields', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);

    const response = await service.createStore(createDto());
    const createArgs = store.create.mock.calls[0][0];

    expect(createArgs.select.databasePasswordEncrypted).toBeUndefined();
    expect(response.data.store).not.toHaveProperty(
      'databasePasswordEncrypted',
    );
  });

  it('does not assign subscriptionPlanId during general store creation', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockResolvedValue(baseStore);
    const dto = {
      ...createDto(),
      subscriptionPlanId: 'b538a21d-edca-45ac-8869-8da0f07e6845',
    } as CreateAdminStoreDto;

    await service.createStore(dto);

    expect(store.create.mock.calls[0][0].data).not.toHaveProperty(
      'subscriptionPlanId',
    );
  });

  it('lists stores ordered newest first', async () => {
    const stores = [
      { ...baseStore, id: 'new-store', createdAt: now },
      {
        ...baseStore,
        id: 'old-store',
        createdAt: new Date('2026-07-05T10:00:00.000Z'),
      },
    ];
    store.findMany.mockResolvedValue(stores);

    const response = await service.listStores({});

    expect(store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: {
          createdAt: 'desc',
        },
      }),
    );
    expect(response).toEqual({
      success: true,
      message: 'Stores retrieved successfully',
      data: {
        stores,
      },
    });
  });

  it('supports status and search filters when listing stores', async () => {
    store.findMany.mockResolvedValue([baseStore]);

    const query: ListAdminStoresQueryDto = {
      search: 'demo',
      status: StoreStatus.TRIAL,
    };

    await service.listStores(query);

    expect(store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: StoreStatus.TRIAL,
          OR: [
            { storeName: { contains: 'demo', mode: 'insensitive' } },
            { storeSlug: { contains: 'demo', mode: 'insensitive' } },
            { ownerName: { contains: 'demo', mode: 'insensitive' } },
            { ownerEmail: { contains: 'demo', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });

  it('returns a store by id', async () => {
    store.findUnique.mockResolvedValue(baseStore);

    const response = await service.getStoreById(baseStore.id);

    expect(store.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: baseStore.id,
        },
      }),
    );
    expect(response).toEqual({
      success: true,
      message: 'Store retrieved successfully',
      data: {
        store: baseStore,
      },
    });
  });

  it('throws NotFoundException when a store is missing', async () => {
    store.findUnique.mockResolvedValue(null);

    await expect(service.getStoreById(baseStore.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates a store successfully', async () => {
    const updatedStore = {
      ...baseStore,
      storeName: 'Demo Store Updated',
      ownerPhone: '+970599111111',
      primaryColor: '#0F766E',
      secondaryColor: '#111827',
    };
    store.findUnique.mockResolvedValue({
      id: baseStore.id,
      storeSlug: baseStore.storeSlug,
      databaseName: baseStore.databaseName,
    });
    store.findFirst.mockResolvedValue(null);
    store.update.mockResolvedValue(updatedStore);

    const response = await service.updateStore(baseStore.id, {
      storeName: 'Demo Store Updated',
      ownerPhone: '+970599111111',
      primaryColor: '#0F766E',
      secondaryColor: '#111827',
    });

    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: baseStore.id,
        },
        data: {
          storeName: 'Demo Store Updated',
          ownerPhone: '+970599111111',
          primaryColor: '#0F766E',
          secondaryColor: '#111827',
        },
      }),
    );
    expect(response).toEqual({
      success: true,
      message: 'Store updated successfully',
      data: {
        store: updatedStore,
      },
    });
  });

  it('rejects an empty store update body', async () => {
    await expect(service.updateStore(baseStore.id, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(store.findUnique).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it('rejects a store update when the store is missing', async () => {
    store.findUnique.mockResolvedValue(null);

    await expect(
      service.updateStore(baseStore.id, {
        storeName: 'Demo Store Updated',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(store.update).not.toHaveBeenCalled();
  });

  it('rejects duplicate storeSlug on update', async () => {
    store.findUnique.mockResolvedValue({
      id: baseStore.id,
      storeSlug: baseStore.storeSlug,
      databaseName: baseStore.databaseName,
    });
    store.findFirst.mockResolvedValue({
      storeSlug: 'taken-store',
      databaseName: null,
    });

    await expect(
      service.updateStore(baseStore.id, {
        storeSlug: 'TAKEN-STORE',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(store.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: {
            not: baseStore.id,
          },
          OR: [{ storeSlug: 'taken-store' }],
        },
      }),
    );
    expect(store.update).not.toHaveBeenCalled();
  });

  it('translates Prisma P2002 update races to ConflictException', async () => {
    store.findUnique.mockResolvedValue({
      id: baseStore.id,
      storeSlug: baseStore.storeSlug,
      databaseName: baseStore.databaseName,
    });
    store.findFirst.mockResolvedValue(null);
    store.update.mockRejectedValue(
      createPrismaKnownRequestError('P2002', {
        target: ['storeSlug'],
      }),
    );

    await expect(
      service.updateStore(baseStore.id, {
        storeSlug: 'updated-store',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not modify subscriptionPlanId during general store updates', async () => {
    store.findUnique.mockResolvedValue({
      id: baseStore.id,
      storeSlug: baseStore.storeSlug,
      databaseName: baseStore.databaseName,
    });
    store.update.mockResolvedValue(baseStore);

    await service.updateStore(baseStore.id, {
      storeName: 'Updated Store',
      subscriptionPlanId: 'b538a21d-edca-45ac-8869-8da0f07e6845',
    } as UpdateAdminStoreDto);

    expect(store.update.mock.calls[0][0].data).toEqual({
      storeName: 'Updated Store',
    });
  });

  it('updates store status successfully', async () => {
    const updatedStore = {
      ...baseStore,
      status: StoreStatus.ACTIVE,
    };
    store.findUnique.mockResolvedValue({
      id: baseStore.id,
      storeSlug: baseStore.storeSlug,
      databaseName: baseStore.databaseName,
    });
    store.update.mockResolvedValue(updatedStore);

    const response = await service.updateStoreStatus(baseStore.id, {
      status: StoreStatus.ACTIVE,
    });

    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: baseStore.id,
        },
        data: {
          status: StoreStatus.ACTIVE,
        },
      }),
    );
    expect(response).toEqual({
      success: true,
      message: 'Store status updated successfully',
      data: {
        store: updatedStore,
      },
    });
  });

  it('rejects status update when the store is missing', async () => {
    store.findUnique.mockResolvedValue(null);

    await expect(
      service.updateStoreStatus(baseStore.id, {
        status: StoreStatus.ACTIVE,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(store.update).not.toHaveBeenCalled();
  });

  describe('tenant provisioning operations', () => {
    it('returns only the safe provisioning status response', async () => {
      const response = await service.getStoreProvisioning(baseStore.id);

      expect(tenantProvisioning.getProvisioningStatus).toHaveBeenCalledWith(
        baseStore.id,
      );
      expect(response).toEqual({
        success: true,
        message: 'Store provisioning status retrieved successfully',
        data: { provisioning },
      });
      expect(JSON.stringify(response)).not.toMatch(
        /databasePasswordEncrypted|encryptionKeyVersion|databaseHost|databaseUser|postgresql:\/\//,
      );
    });

    it.each([
      TenantProvisioningErrorCode.STORE_NOT_FOUND,
      TenantProvisioningErrorCode.PROVISIONING_NOT_FOUND,
    ])('maps %s status lookup failures to NotFoundException', async (code) => {
      tenantProvisioning.getProvisioningStatus.mockRejectedValue(
        createTenantProvisioningError(code),
      );

      await expect(
        service.getStoreProvisioning(baseStore.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('retries provisioning through the existing state machine', async () => {
      const response = await service.retryStoreProvisioning(baseStore.id);

      expect(tenantProvisioning.provisionStore).toHaveBeenCalledTimes(1);
      expect(tenantProvisioning.provisionStore).toHaveBeenCalledWith(
        baseStore.id,
      );
      expect(response).toEqual({
        success: true,
        message: 'Store provisioning completed successfully',
        data: {
          provisioning,
          alreadyReady: false,
        },
      });
    });

    it('returns a deterministic idempotent response for READY provisioning', async () => {
      tenantProvisioning.provisionStore.mockResolvedValue({
        provisioning,
        alreadyReady: true,
      });

      await expect(
        service.retryStoreProvisioning(baseStore.id),
      ).resolves.toMatchObject({
        success: true,
        message: 'Store provisioning is already complete',
        data: { alreadyReady: true },
      });
    });

    it('maps active provisioning to a stable conflict', async () => {
      tenantProvisioning.provisionStore.mockRejectedValue(
        createTenantProvisioningError(
          TenantProvisioningErrorCode.PROVISIONING_IN_PROGRESS,
        ),
      );

      await expect(
        service.retryStoreProvisioning(baseStore.id),
      ).rejects.toMatchObject({
        response: {
          success: false,
          message: 'Tenant database provisioning is already in progress.',
          code: TenantProvisioningErrorCode.PROVISIONING_IN_PROGRESS,
        },
      });
    });

    it('maps invalid server configuration to ServiceUnavailableException', async () => {
      tenantProvisioning.provisionStore.mockRejectedValue(
        createTenantProvisioningError(
          TenantProvisioningErrorCode.CONFIGURATION_INVALID,
        ),
      );

      await expect(
        service.retryStoreProvisioning(baseStore.id),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('maps an unexpected runtime provisioning code to a generic safe error', async () => {
      const internalDetails =
        'unexpected code from postgresql://admin:secret@localhost/postgres';
      tenantProvisioning.provisionStore.mockRejectedValue(
        new TenantProvisioningError(
          'TENANT_FUTURE_INTERNAL_FAILURE' as TenantProvisioningErrorCode,
          internalDetails,
        ),
      );

      let caught: unknown;
      try {
        await service.retryStoreProvisioning(baseStore.id);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      expect((caught as HttpException).getResponse()).toEqual({
        success: false,
        message: 'Tenant database provisioning failed.',
        code: TenantProvisioningErrorCode.PROVISIONING_FAILED,
      });
      expect(JSON.stringify(caught)).not.toContain(internalDetails);
      expect(caught).toBeDefined();
    });

    it.each([
      [TenantProvisioningErrorCode.IDENTIFIER_INVALID, HttpStatus.BAD_REQUEST],
      [
        TenantProvisioningErrorCode.DATABASE_URL_INVALID,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        TenantProvisioningErrorCode.CONFIGURATION_INVALID,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        TenantProvisioningErrorCode.ENCRYPTION_KEY_INVALID,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        TenantProvisioningErrorCode.CREDENTIAL_ENCRYPTION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
      ],
      [
        TenantProvisioningErrorCode.CREDENTIAL_DECRYPTION_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
      ],
      [
        TenantProvisioningErrorCode.POSTGRES_ADMIN_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [TenantProvisioningErrorCode.ROLE_CONFLICT, HttpStatus.CONFLICT],
      [
        TenantProvisioningErrorCode.ROLE_PROVISIONING_FAILED,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        TenantProvisioningErrorCode.DATABASE_OWNER_CONFLICT,
        HttpStatus.CONFLICT,
      ],
      [
        TenantProvisioningErrorCode.DATABASE_PROVISIONING_FAILED,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        TenantProvisioningErrorCode.MIGRATION_FAILED,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [TenantProvisioningErrorCode.IDENTITY_MISMATCH, HttpStatus.CONFLICT],
      [
        TenantProvisioningErrorCode.IDENTITY_INITIALIZATION_FAILED,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        TenantProvisioningErrorCode.VERIFICATION_FAILED,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        TenantProvisioningErrorCode.IDENTITY_CLEANUP_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
      ],
      [TenantProvisioningErrorCode.OWNER_CONFLICT, HttpStatus.CONFLICT],
      [
        TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        TenantProvisioningErrorCode.OWNER_CLEANUP_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
      ],
      [TenantProvisioningErrorCode.STORE_NOT_FOUND, HttpStatus.NOT_FOUND],
      [
        TenantProvisioningErrorCode.PROVISIONING_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      ],
      [TenantProvisioningErrorCode.IDENTIFIER_CONFLICT, HttpStatus.CONFLICT],
      [
        TenantProvisioningErrorCode.RECORD_INTEGRITY_FAILED,
        HttpStatus.CONFLICT,
      ],
      [TenantProvisioningErrorCode.CONFIGURATION_DRIFT, HttpStatus.CONFLICT],
      [
        TenantProvisioningErrorCode.PROVISIONING_IN_PROGRESS,
        HttpStatus.CONFLICT,
      ],
      [
        TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
        HttpStatus.CONFLICT,
      ],
      [
        TenantProvisioningErrorCode.PROVISIONING_FAILED,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
    ])('maps %s to stable HTTP status %s', async (code, status) => {
      tenantProvisioning.provisionStore.mockRejectedValue(
        createTenantProvisioningError(code),
      );

      let caught: unknown;
      try {
        await service.retryStoreProvisioning(baseStore.id);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(status);
      expect((caught as HttpException).getResponse()).toMatchObject({
        success: false,
        message: getTenantProvisioningSafeMessage(code),
        code,
      });
    });

    it.each([
      [TenantProvisioningErrorCode.OWNER_CONFLICT, HttpStatus.CONFLICT],
      [
        TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        TenantProvisioningErrorCode.OWNER_CLEANUP_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
      ],
    ])(
      'does not expose owner details when translating %s',
      async (code, status) => {
        const rawDetails =
          'Demo Owner|owner@example.com|+970599000000|postgresql://tenant:secret@internal/tenant|raw Prisma detail';
        tenantProvisioning.provisionStore.mockRejectedValue(
          new TenantProvisioningError(code, rawDetails),
        );

        let caught: unknown;
        try {
          await service.retryStoreProvisioning(baseStore.id);
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(HttpException);
        expect((caught as HttpException).getStatus()).toBe(status);
        expect((caught as HttpException).getResponse()).toEqual({
          success: false,
          message: getTenantProvisioningSafeMessage(code),
          code,
        });
        expect(JSON.stringify(caught)).not.toContain(rawDetails);
        expect(JSON.stringify(caught)).not.toContain('owner@example.com');
        expect(JSON.stringify(caught)).not.toContain('postgresql://');
      },
    );

    it('returns no credentials or connection URL from retry', async () => {
      const response = await service.retryStoreProvisioning(baseStore.id);
      const serialized = JSON.stringify(response);

      expect(serialized).not.toMatch(
        /password|databasePasswordEncrypted|encryptionKeyVersion|databaseHost|databaseUser|postgresql:\/\//i,
      );
    });
  });

  describe('subscription management', () => {
    const storeId = '4de3dc53-bceb-44e1-b94d-aab4f9a7b197';
    const planId = 'b538a21d-edca-45ac-8869-8da0f07e6845';
    const subscriptionId = '5eb2ae2d-67c7-4ab2-b411-9ab0bcaee208';
    const startDate = new Date('2026-07-17T10:00:00.000Z');
    const monthlyEndDate = new Date('2026-08-17T10:00:00.000Z');
    let subscriptionPlanFindUnique: jest.Mock;
    let billingSubscriptionFindFirst: jest.Mock;
    let billingSubscriptionFindMany: jest.Mock;
    let transactionSubscriptionCreate: jest.Mock;
    let transactionStoreUpdate: jest.Mock;
    let transaction: jest.Mock;

    const recurringPlan = {
      id: planId,
      price: new Prisma.Decimal('29.99'),
      billingType: BillingType.RECURRING,
      billingInterval: BillingInterval.MONTHLY,
      intervalCount: 1,
      trialDays: 14,
    };

    function subscription(overrides: Record<string, unknown> = {}) {
      return {
        id: subscriptionId,
        storeId,
        planId,
        startDate,
        endDate: monthlyEndDate,
        status: SubscriptionStatus.ACTIVE,
        isTrial: false,
        amount: recurringPlan.price,
        createdAt: startDate,
        updatedAt: startDate,
        plan: {
          id: planId,
          name: 'Monthly',
          billingType: BillingType.RECURRING,
          billingInterval: BillingInterval.MONTHLY,
          intervalCount: 1,
          trialDays: 14,
        },
        ...overrides,
      };
    }

    beforeEach(() => {
      store.findUnique.mockResolvedValue({ id: storeId });
      subscriptionPlanFindUnique = jest.fn().mockResolvedValue(recurringPlan);
      billingSubscriptionFindFirst = jest.fn().mockResolvedValue(null);
      billingSubscriptionFindMany = jest.fn().mockResolvedValue([]);
      transactionSubscriptionCreate = jest
        .fn()
        .mockResolvedValue(subscription());
      transactionStoreUpdate = jest.fn().mockResolvedValue({ id: storeId });
      transaction = jest.fn(async (callback: (client: unknown) => unknown) =>
        callback({
          billingSubscription: { create: transactionSubscriptionCreate },
          store: { update: transactionStoreUpdate },
        }),
      );

      service = new AdminStoresService(
        {
          store,
          subscriptionPlan: { findUnique: subscriptionPlanFindUnique },
          billingSubscription: {
            findFirst: billingSubscriptionFindFirst,
            findMany: billingSubscriptionFindMany,
          },
          $transaction: transaction,
        } as unknown as PrismaService,
        tenantProvisioning as unknown as TenantProvisioningService,
      );
    });

    it('rejects normal subscription creation when the store is missing', async () => {
      store.findUnique.mockResolvedValue(null);

      await expect(
        service.createStoreSubscription(storeId, { planId }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(subscriptionPlanFindUnique).not.toHaveBeenCalled();
    });

    it('rejects normal subscription creation when the plan is missing', async () => {
      subscriptionPlanFindUnique.mockResolvedValue(null);

      await expect(
        service.createStoreSubscription(storeId, { planId }),
      ).rejects.toMatchObject({
        response: {
          success: false,
          message: 'Subscription plan not found',
        },
      });
    });

    it('rejects trial plans on the normal subscription endpoint', async () => {
      subscriptionPlanFindUnique.mockResolvedValue({
        ...recurringPlan,
        billingType: BillingType.TRIAL,
      });

      await expect(
        service.createStoreSubscription(storeId, { planId }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a normal subscription when a current subscription exists', async () => {
      billingSubscriptionFindFirst.mockResolvedValue({ id: subscriptionId });

      await expect(
        service.createStoreSubscription(storeId, { planId }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(transaction).not.toHaveBeenCalled();
    });

    it('rejects a custom interval without endDate', async () => {
      subscriptionPlanFindUnique.mockResolvedValue({
        ...recurringPlan,
        billingInterval: BillingInterval.CUSTOM,
      });

      await expect(
        service.createStoreSubscription(storeId, {
          planId,
          startDate: startDate.toISOString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an invalid normal subscription date range', async () => {
      await expect(
        service.createStoreSubscription(storeId, {
          planId,
          startDate: startDate.toISOString(),
          endDate: startDate.toISOString(),
        }),
      ).rejects.toMatchObject({
        response: {
          message: 'endDate must be strictly later than startDate',
        },
      });
    });

    it('rejects a recurring plan with a NONE interval', async () => {
      subscriptionPlanFindUnique.mockResolvedValue({
        ...recurringPlan,
        billingInterval: BillingInterval.NONE,
      });

      await expect(
        service.createStoreSubscription(storeId, { planId }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('derives a monthly endDate using calendar months', async () => {
      await service.createStoreSubscription(storeId, {
        planId,
        startDate: startDate.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            endDate: monthlyEndDate,
          }),
        }),
      );
    });

    it('clamps January 31 to February 28 for a monthly subscription', async () => {
      const january31 = new Date('2025-01-31T16:45:30.000Z');

      await service.createStoreSubscription(storeId, {
        planId,
        startDate: january31.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startDate: january31,
            endDate: new Date('2025-02-28T16:45:30.000Z'),
          }),
        }),
      );
    });

    it('clamps January 31 to February 29 in a leap year', async () => {
      const january31 = new Date('2024-01-31T16:45:30.000Z');

      await service.createStoreSubscription(storeId, {
        planId,
        startDate: january31.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startDate: january31,
            endDate: new Date('2024-02-29T16:45:30.000Z'),
          }),
        }),
      );
    });

    it('supports monthly intervalCount greater than one without mutating startDate', async () => {
      const january31 = new Date('2025-01-31T16:45:30.000Z');
      subscriptionPlanFindUnique.mockResolvedValue({
        ...recurringPlan,
        intervalCount: 2,
      });

      await service.createStoreSubscription(storeId, {
        planId,
        startDate: january31.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startDate: january31,
            endDate: new Date('2025-03-31T16:45:30.000Z'),
          }),
        }),
      );
      expect(january31).toEqual(new Date('2025-01-31T16:45:30.000Z'));
    });

    it('derives a yearly endDate using calendar years', async () => {
      subscriptionPlanFindUnique.mockResolvedValue({
        ...recurringPlan,
        billingInterval: BillingInterval.YEARLY,
        intervalCount: 2,
      });

      await service.createStoreSubscription(storeId, {
        planId,
        startDate: startDate.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            endDate: new Date('2028-07-17T10:00:00.000Z'),
          }),
        }),
      );
    });

    it('clamps February 29 to February 28 in a non-leap year', async () => {
      const leapDay = new Date('2024-02-29T08:15:00.000Z');
      subscriptionPlanFindUnique.mockResolvedValue({
        ...recurringPlan,
        billingInterval: BillingInterval.YEARLY,
        intervalCount: 1,
      });

      await service.createStoreSubscription(storeId, {
        planId,
        startDate: leapDay.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startDate: leapDay,
            endDate: new Date('2025-02-28T08:15:00.000Z'),
          }),
        }),
      );
    });

    it('creates a custom-period subscription with the requested dates', async () => {
      const customEndDate = new Date('2026-10-01T10:00:00.000Z');
      subscriptionPlanFindUnique.mockResolvedValue({
        ...recurringPlan,
        billingInterval: BillingInterval.CUSTOM,
      });

      await service.createStoreSubscription(storeId, {
        planId,
        startDate: startDate.toISOString(),
        endDate: customEndDate.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startDate,
            endDate: customEndDate,
            status: SubscriptionStatus.ACTIVE,
          }),
        }),
      );
    });

    it('creates a one-time NONE subscription as lifetime', async () => {
      subscriptionPlanFindUnique.mockResolvedValue({
        ...recurringPlan,
        billingType: BillingType.ONE_TIME,
        billingInterval: BillingInterval.NONE,
      });

      await service.createStoreSubscription(storeId, {
        planId,
        startDate: startDate.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            endDate: null,
            status: SubscriptionStatus.LIFETIME,
          }),
        }),
      );
    });

    it('copies the plan price and marks a normal subscription as non-trial', async () => {
      await service.createStoreSubscription(storeId, {
        planId,
        startDate: startDate.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amount: recurringPlan.price,
            isTrial: false,
          }),
        }),
      );
    });

    it('creates the subscription and updates the store in one transaction', async () => {
      await service.createStoreSubscription(storeId, {
        planId,
        startDate: startDate.toISOString(),
      });

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transactionSubscriptionCreate).toHaveBeenCalledTimes(1);
      expect(store.update).not.toHaveBeenCalled();
      expect(transactionStoreUpdate).toHaveBeenCalledWith({
        where: { id: storeId },
        data: {
          subscriptionPlanId: planId,
          status: StoreStatus.ACTIVE,
        },
        select: { id: true },
      });
    });

    it('uses an explicit subscription response projection without Store data', async () => {
      await service.createStoreSubscription(storeId, {
        planId,
        startDate: startDate.toISOString(),
      });

      const select = transactionSubscriptionCreate.mock.calls[0][0].select;
      expect(select).toEqual({
        id: true,
        storeId: true,
        planId: true,
        startDate: true,
        endDate: true,
        status: true,
        isTrial: true,
        amount: true,
        createdAt: true,
        updatedAt: true,
        plan: {
          select: {
            id: true,
            name: true,
            billingType: true,
            billingInterval: true,
            intervalCount: true,
            trialDays: true,
          },
        },
      });
      expect(select).not.toHaveProperty('store');
    });

    it('translates a partial unique-index race to ConflictException', async () => {
      transaction.mockRejectedValue(
        createPrismaKnownRequestError('P2002', {
          target: ['store_id'],
        }),
      );

      await expect(
        service.createStoreSubscription(storeId, {
          planId,
          startDate: startDate.toISOString(),
        }),
      ).rejects.toMatchObject({
        response: {
          success: false,
          message: 'Store already has a current operational subscription',
        },
      });
    });

    it('does not misclassify unrelated P2002 errors as current-subscription conflicts', async () => {
      transaction.mockRejectedValue(
        createPrismaKnownRequestError('P2002', {
          target: ['id'],
        }),
      );

      await expect(
        service.createStoreSubscription(storeId, {
          planId,
          startDate: startDate.toISOString(),
        }),
      ).rejects.toMatchObject({
        response: {
          success: false,
          message: 'Subscription already exists',
        },
      });
    });

    it('rejects trial creation when the store is missing', async () => {
      store.findUnique.mockResolvedValue(null);

      await expect(
        service.startStoreTrial(storeId, { planId, trialDays: 7 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects trial creation when the plan is missing', async () => {
      subscriptionPlanFindUnique.mockResolvedValue(null);

      await expect(
        service.startStoreTrial(storeId, { planId, trialDays: 7 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a trial-ineligible plan', async () => {
      subscriptionPlanFindUnique.mockResolvedValue({
        ...recurringPlan,
        trialDays: null,
      });

      await expect(
        service.startStoreTrial(storeId, { planId, trialDays: 7 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects trial requests with both endDate and trialDays', async () => {
      await expect(
        service.startStoreTrial(storeId, {
          planId,
          endDate: monthlyEndDate.toISOString(),
          trialDays: 7,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a trial when no duration is available', async () => {
      subscriptionPlanFindUnique.mockResolvedValue({
        ...recurringPlan,
        billingType: BillingType.TRIAL,
        trialDays: null,
      });

      await expect(
        service.startStoreTrial(storeId, { planId }),
      ).rejects.toMatchObject({
        response: {
          message: 'A positive trial duration is required',
        },
      });
    });

    it('rejects an invalid trial date range', async () => {
      await expect(
        service.startStoreTrial(storeId, {
          planId,
          startDate: startDate.toISOString(),
          endDate: startDate.toISOString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a repeated trial', async () => {
      billingSubscriptionFindFirst.mockResolvedValueOnce({
        id: subscriptionId,
      });

      await expect(
        service.startStoreTrial(storeId, { planId, trialDays: 7 }),
      ).rejects.toMatchObject({
        response: {
          message: 'Store has already used a trial subscription',
        },
      });
    });

    it('rejects a trial when a current subscription exists', async () => {
      billingSubscriptionFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: subscriptionId });

      await expect(
        service.startStoreTrial(storeId, { planId, trialDays: 7 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('uses plan trialDays by default', async () => {
      await service.startStoreTrial(storeId, {
        planId,
        startDate: startDate.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            endDate: new Date('2026-07-31T10:00:00.000Z'),
          }),
        }),
      );
    });

    it('uses request trialDays instead of the plan default', async () => {
      await service.startStoreTrial(storeId, {
        planId,
        startDate: startDate.toISOString(),
        trialDays: 5,
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            endDate: new Date('2026-07-22T10:00:00.000Z'),
          }),
        }),
      );
    });

    it('uses an explicit trial endDate', async () => {
      await service.startStoreTrial(storeId, {
        planId,
        startDate: startDate.toISOString(),
        endDate: monthlyEndDate.toISOString(),
      });

      expect(transactionSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            endDate: monthlyEndDate,
          }),
        }),
      );
    });

    it('creates a zero-amount trial marked with isTrial', async () => {
      await service.startStoreTrial(storeId, {
        planId,
        startDate: startDate.toISOString(),
      });

      const data = transactionSubscriptionCreate.mock.calls[0][0].data;
      expect(data.amount.toString()).toBe('0');
      expect(data).toEqual(
        expect.objectContaining({
          isTrial: true,
          status: SubscriptionStatus.TRIALING,
        }),
      );
    });

    it('updates Store status to TRIAL in the trial transaction', async () => {
      await service.startStoreTrial(storeId, {
        planId,
        startDate: startDate.toISOString(),
      });

      expect(transactionStoreUpdate).toHaveBeenCalledWith({
        where: { id: storeId },
        data: {
          subscriptionPlanId: planId,
          status: StoreStatus.TRIAL,
        },
        select: { id: true },
      });
    });

    it('translates a trial partial unique-index race to ConflictException', async () => {
      transaction.mockRejectedValue(
        createPrismaKnownRequestError('P2002', {
          constraint: 'billing_subscriptions_one_current_per_store_uidx',
        }),
      );

      await expect(
        service.startStoreTrial(storeId, {
          planId,
          startDate: startDate.toISOString(),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('returns the current operational subscription', async () => {
      const currentSubscription = subscription();
      billingSubscriptionFindFirst.mockResolvedValue(currentSubscription);

      await expect(
        service.getCurrentStoreSubscription(storeId),
      ).resolves.toEqual({
        success: true,
        message: 'Current store subscription retrieved successfully',
        data: { subscription: currentSubscription },
      });
      expect(billingSubscriptionFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            storeId,
            status: {
              in: [
                SubscriptionStatus.TRIALING,
                SubscriptionStatus.ACTIVE,
                SubscriptionStatus.PAST_DUE,
                SubscriptionStatus.LIFETIME,
              ],
            },
          },
        }),
      );
    });

    it('returns 404 when the current subscription is missing', async () => {
      await expect(
        service.getCurrentStoreSubscription(storeId),
      ).rejects.toMatchObject({
        response: {
          message: 'Current store subscription not found',
        },
      });
    });

    it('lists subscription history in the required order', async () => {
      const subscriptions = [subscription()];
      billingSubscriptionFindMany.mockResolvedValue(subscriptions);

      await expect(service.listStoreSubscriptions(storeId, {})).resolves.toEqual(
        {
          success: true,
          message: 'Store subscription history retrieved successfully',
          data: { subscriptions },
        },
      );
      expect(billingSubscriptionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
        }),
      );
    });

    it('filters subscription history by status', async () => {
      await service.listStoreSubscriptions(storeId, {
        status: SubscriptionStatus.EXPIRED,
      });

      expect(billingSubscriptionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            storeId,
            status: SubscriptionStatus.EXPIRED,
          },
        }),
      );
    });
  });
});
