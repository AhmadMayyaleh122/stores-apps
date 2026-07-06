import { StoreStatus } from '../../../generated/prisma/client';
import {
  AdminStoreResponse,
  AdminStoresListResponse,
  AdminStoresService,
} from './admin-stores.service';
import { AdminStoresController } from './admin-stores.controller';
import { CreateAdminStoreDto } from './dto/create-admin-store.dto';
import { ListAdminStoresQueryDto } from './dto/list-admin-stores-query.dto';

describe('AdminStoresController', () => {
  let controller: AdminStoresController;
  let adminStoresService: jest.Mocked<
    Pick<AdminStoresService, 'createStore' | 'listStores' | 'getStoreById'>
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
});
