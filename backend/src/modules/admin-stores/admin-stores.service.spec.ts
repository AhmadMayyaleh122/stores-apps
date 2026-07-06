import { ConflictException, NotFoundException } from '@nestjs/common';

import { StoreStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AdminStoresService } from './admin-stores.service';
import { CreateAdminStoreDto } from './dto/create-admin-store.dto';
import { ListAdminStoresQueryDto } from './dto/list-admin-stores-query.dto';

type MockPrismaStore = {
  findFirst: jest.Mock;
  create: jest.Mock;
  findMany: jest.Mock;
  findUnique: jest.Mock;
};

describe('AdminStoresService', () => {
  let service: AdminStoresService;
  let store: MockPrismaStore;

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

  beforeEach(() => {
    store = {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    };

    service = new AdminStoresService({
      store,
    } as unknown as PrismaService);
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
});
