import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';

import { StoreStatus } from '../../../generated/prisma/client';
import {
  AdminStoreResponse,
  AdminStoresListResponse,
  AdminStoresService,
} from './admin-stores.service';
import { AdminStoresController } from './admin-stores.controller';
import { CreateAdminStoreDto } from './dto/create-admin-store.dto';
import { ListAdminStoresQueryDto } from './dto/list-admin-stores-query.dto';
import { UpdateAdminStoreDto } from './dto/update-admin-store.dto';
import { UpdateAdminStoreStatusDto } from './dto/update-admin-store-status.dto';

describe('AdminStoresController', () => {
  let controller: AdminStoresController;
  let adminStoresService: jest.Mocked<
    Pick<
      AdminStoresService,
      | 'createStore'
      | 'listStores'
      | 'getStoreById'
      | 'updateStore'
      | 'updateStoreStatus'
    >
  >;

  const store = {
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
    createdAt: new Date('2026-07-06T10:00:00.000Z'),
    updatedAt: new Date('2026-07-06T10:00:00.000Z'),
  };

  beforeEach(() => {
    adminStoresService = {
      createStore: jest.fn(),
      listStores: jest.fn(),
      getStoreById: jest.fn(),
      updateStore: jest.fn(),
      updateStoreStatus: jest.fn(),
    };

    controller = new AdminStoresController(
      adminStoresService as unknown as AdminStoresService,
    );
  });

  it('POST /admin/stores delegates to service and returns response shape', async () => {
    const dto: CreateAdminStoreDto = {
      storeName: 'Demo Store',
      storeSlug: 'demo-store',
      ownerName: 'Demo Owner',
      ownerEmail: 'owner@example.com',
    };
    const serviceResponse: AdminStoreResponse = {
      success: true,
      message: 'Store created successfully',
      data: {
        store,
      },
    };
    adminStoresService.createStore.mockResolvedValue(serviceResponse);

    await expect(controller.createStore(dto)).resolves.toEqual(
      serviceResponse,
    );
    expect(adminStoresService.createStore).toHaveBeenCalledWith(dto);
  });

  it('GET /admin/stores delegates to service and returns response shape', async () => {
    const query: ListAdminStoresQueryDto = {
      search: 'demo',
      status: StoreStatus.TRIAL,
    };
    const serviceResponse: AdminStoresListResponse = {
      success: true,
      message: 'Stores retrieved successfully',
      data: {
        stores: [store],
      },
    };
    adminStoresService.listStores.mockResolvedValue(serviceResponse);

    await expect(controller.listStores(query)).resolves.toEqual(
      serviceResponse,
    );
    expect(adminStoresService.listStores).toHaveBeenCalledWith(query);
  });

  it('GET /admin/stores/:id delegates to service and returns response shape', async () => {
    const serviceResponse: AdminStoreResponse = {
      success: true,
      message: 'Store retrieved successfully',
      data: {
        store,
      },
    };
    adminStoresService.getStoreById.mockResolvedValue(serviceResponse);

    await expect(controller.getStoreById(store.id)).resolves.toEqual(
      serviceResponse,
    );
    expect(adminStoresService.getStoreById).toHaveBeenCalledWith(store.id);
  });

  it('GET /admin/stores/:id validates id as a UUID', async () => {
    await expectUuidPipeRejectsInvalidId('getStoreById');
  });

  it('PATCH /admin/stores/:id delegates to service and returns response shape', async () => {
    const dto: UpdateAdminStoreDto = {
      storeName: 'Demo Store Updated',
      ownerPhone: '+970599111111',
    };
    const serviceResponse: AdminStoreResponse = {
      success: true,
      message: 'Store updated successfully',
      data: {
        store: {
          ...store,
          ...dto,
        },
      },
    };
    adminStoresService.updateStore.mockResolvedValue(serviceResponse);

    await expect(controller.updateStore(store.id, dto)).resolves.toEqual(
      serviceResponse,
    );
    expect(adminStoresService.updateStore).toHaveBeenCalledWith(
      store.id,
      dto,
    );
  });

  it('PATCH /admin/stores/:id/status delegates to service and returns response shape', async () => {
    const dto: UpdateAdminStoreStatusDto = {
      status: StoreStatus.ACTIVE,
    };
    const serviceResponse: AdminStoreResponse = {
      success: true,
      message: 'Store status updated successfully',
      data: {
        store: {
          ...store,
          status: StoreStatus.ACTIVE,
        },
      },
    };
    adminStoresService.updateStoreStatus.mockResolvedValue(serviceResponse);

    await expect(
      controller.updateStoreStatus(store.id, dto),
    ).resolves.toEqual(serviceResponse);
    expect(adminStoresService.updateStoreStatus).toHaveBeenCalledWith(
      store.id,
      dto,
    );
  });

  it('PATCH /admin/stores/:id validates id as a UUID', async () => {
    await expectUuidPipeRejectsInvalidId('updateStore');
  });

  it('PATCH /admin/stores/:id/status validates id as a UUID', async () => {
    await expectUuidPipeRejectsInvalidId('updateStoreStatus');
  });

  async function expectUuidPipeRejectsInvalidId(
    methodName:
      | 'getStoreById'
      | 'updateStore'
      | 'updateStoreStatus',
  ): Promise<void> {
    const metadata = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      AdminStoresController,
      methodName,
    ) as Record<string, { data: string; pipes: unknown[] }>;
    const idParam = Object.values(metadata).find(
      (param) => param.data === 'id',
    );
    const uuidPipe = idParam?.pipes.find(
      (pipe) => pipe instanceof ParseUUIDPipe,
    ) as ParseUUIDPipe | undefined;

    await expect(
      uuidPipe?.transform('not-a-uuid', {
        type: 'param',
        metatype: String,
        data: 'id',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  }
});
