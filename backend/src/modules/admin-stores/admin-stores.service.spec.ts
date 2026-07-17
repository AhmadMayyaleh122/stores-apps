import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { Prisma, StoreStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AdminStoresService } from './admin-stores.service';
import { CreateAdminStoreDto } from './dto/create-admin-store.dto';
import { ListAdminStoresQueryDto } from './dto/list-admin-stores-query.dto';

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
      update: jest.fn(),
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

  it('translates Prisma P2003 relation failures to BadRequestException', async () => {
    store.findFirst.mockResolvedValue(null);
    store.create.mockRejectedValue(createPrismaKnownRequestError('P2003'));

    await expect(
      service.createStore(
        createDto({
          subscriptionPlanId: '4de3dc53-bceb-44e1-b94d-aab4f9a7b197',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
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

  it('translates Prisma P2003 update failures to BadRequestException', async () => {
    store.findUnique.mockResolvedValue({
      id: baseStore.id,
      storeSlug: baseStore.storeSlug,
      databaseName: baseStore.databaseName,
    });
    store.update.mockRejectedValue(createPrismaKnownRequestError('P2003'));

    await expect(
      service.updateStore(baseStore.id, {
        subscriptionPlanId: '4de3dc53-bceb-44e1-b94d-aab4f9a7b197',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
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
});
