import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';

import {
  BillingInterval,
  BillingType,
  Prisma,
  StoreStatus,
  SubscriptionStatus,
} from '../../../generated/prisma/client';
import { AdminJwtAuthGuard } from '../admin-auth/guards/admin-jwt-auth.guard';
import {
  AdminStoreResponse,
  AdminStoreProvisioningResponse,
  AdminStoreProvisioningRetryResponse,
  AdminStoreSubscriptionResponse,
  AdminStoreSubscriptionsListResponse,
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
      | 'getStoreProvisioning'
      | 'retryStoreProvisioning'
      | 'getCurrentStoreSubscription'
      | 'listStoreSubscriptions'
      | 'createStoreSubscription'
      | 'startStoreTrial'
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

  const provisioning = {
    id: '98765432-1234-4234-8123-456789012345',
    storeId: store.id,
    status: 'READY' as const,
    databaseName: 'tenant_db_4de3dc53bceb44e1b94daab4f9a7b197',
    attemptCount: 1,
    provisioningStartedAt: new Date('2026-08-02T10:00:00.000Z'),
    provisionedAt: new Date('2026-08-02T10:01:00.000Z'),
    failedAt: null,
    lastFailureCode: null,
    lastFailureMessage: null,
    createdAt: new Date('2026-08-02T10:00:00.000Z'),
    updatedAt: new Date('2026-08-02T10:01:00.000Z'),
  };

  beforeEach(() => {
    adminStoresService = {
      createStore: jest.fn(),
      listStores: jest.fn(),
      getStoreById: jest.fn(),
      updateStore: jest.fn(),
      updateStoreStatus: jest.fn(),
      getStoreProvisioning: jest.fn(),
      retryStoreProvisioning: jest.fn(),
      getCurrentStoreSubscription: jest.fn(),
      listStoreSubscriptions: jest.fn(),
      createStoreSubscription: jest.fn(),
      startStoreTrial: jest.fn(),
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

  it('keeps AdminJwtAuthGuard applied to the controller', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminStoresController,
    ) as unknown[];

    expect(guards).toContain(AdminJwtAuthGuard);
  });

  it('GET /admin/stores/:storeId/provisioning delegates and returns the safe response', async () => {
    const serviceResponse: AdminStoreProvisioningResponse = {
      success: true,
      message: 'Store provisioning status retrieved successfully',
      data: { provisioning },
    };
    adminStoresService.getStoreProvisioning.mockResolvedValue(serviceResponse);

    await expect(
      controller.getStoreProvisioning(store.id),
    ).resolves.toEqual(serviceResponse);
    expect(adminStoresService.getStoreProvisioning).toHaveBeenCalledWith(
      store.id,
    );
    expect(JSON.stringify(serviceResponse)).not.toMatch(
      /password|databaseHost|databaseUser|postgresql:\/\//i,
    );
  });

  it('POST /admin/stores/:storeId/provisioning/retry delegates and returns the safe response', async () => {
    const serviceResponse: AdminStoreProvisioningRetryResponse = {
      success: true,
      message: 'Store provisioning completed successfully',
      data: { provisioning, alreadyReady: false },
    };
    adminStoresService.retryStoreProvisioning.mockResolvedValue(
      serviceResponse,
    );

    await expect(
      controller.retryStoreProvisioning(store.id),
    ).resolves.toEqual(serviceResponse);
    expect(adminStoresService.retryStoreProvisioning).toHaveBeenCalledWith(
      store.id,
    );
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        AdminStoresController.prototype.retryStoreProvisioning,
      ),
    ).toBe(200);
  });

  it('GET /admin/stores/:storeId/subscription delegates and forwards the response', async () => {
    const serviceResponse = createSubscriptionResponse(
      'Current store subscription retrieved successfully',
    );
    adminStoresService.getCurrentStoreSubscription.mockResolvedValue(
      serviceResponse,
    );

    await expect(
      controller.getCurrentStoreSubscription(store.id),
    ).resolves.toEqual(serviceResponse);
    expect(
      adminStoresService.getCurrentStoreSubscription,
    ).toHaveBeenCalledWith(store.id);
  });

  it('GET /admin/stores/:storeId/subscriptions forwards query and response', async () => {
    const query = { status: SubscriptionStatus.EXPIRED };
    const subscriptionResponse = createSubscriptionResponse('unused');
    const serviceResponse: AdminStoreSubscriptionsListResponse = {
      success: true,
      message: 'Store subscription history retrieved successfully',
      data: {
        subscriptions: [subscriptionResponse.data.subscription],
      },
    };
    adminStoresService.listStoreSubscriptions.mockResolvedValue(
      serviceResponse,
    );

    await expect(
      controller.listStoreSubscriptions(store.id, query),
    ).resolves.toEqual(serviceResponse);
    expect(adminStoresService.listStoreSubscriptions).toHaveBeenCalledWith(
      store.id,
      query,
    );
  });

  it('POST /admin/stores/:storeId/subscriptions forwards DTO and response', async () => {
    const dto = {
      planId: 'b538a21d-edca-45ac-8869-8da0f07e6845',
      startDate: '2026-07-17T10:00:00.000Z',
    };
    const serviceResponse = createSubscriptionResponse(
      'Store subscription created successfully',
    );
    adminStoresService.createStoreSubscription.mockResolvedValue(
      serviceResponse,
    );

    await expect(
      controller.createStoreSubscription(store.id, dto),
    ).resolves.toEqual(serviceResponse);
    expect(adminStoresService.createStoreSubscription).toHaveBeenCalledWith(
      store.id,
      dto,
    );
  });

  it('POST /admin/stores/:storeId/subscriptions/trial forwards DTO and response', async () => {
    const dto = {
      planId: 'b538a21d-edca-45ac-8869-8da0f07e6845',
      trialDays: 14,
    };
    const serviceResponse = createSubscriptionResponse(
      'Store trial started successfully',
    );
    adminStoresService.startStoreTrial.mockResolvedValue(serviceResponse);

    await expect(controller.startStoreTrial(store.id, dto)).resolves.toEqual(
      serviceResponse,
    );
    expect(adminStoresService.startStoreTrial).toHaveBeenCalledWith(
      store.id,
      dto,
    );
  });

  it.each([
    'getCurrentStoreSubscription',
    'listStoreSubscriptions',
    'createStoreSubscription',
    'startStoreTrial',
    'getStoreProvisioning',
    'retryStoreProvisioning',
  ] as const)('%s validates storeId as a UUID', async (methodName) => {
    await expectUuidPipeRejectsInvalidId(methodName, 'storeId');
  });

  function createSubscriptionResponse(
    message: string,
  ): AdminStoreSubscriptionResponse {
    return {
      success: true,
      message,
      data: {
        subscription: {
          id: '5eb2ae2d-67c7-4ab2-b411-9ab0bcaee208',
          storeId: store.id,
          planId: 'b538a21d-edca-45ac-8869-8da0f07e6845',
          startDate: new Date('2026-07-17T10:00:00.000Z'),
          endDate: new Date('2026-08-17T10:00:00.000Z'),
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          amount: new Prisma.Decimal('29.99'),
          createdAt: new Date('2026-07-17T10:00:00.000Z'),
          updatedAt: new Date('2026-07-17T10:00:00.000Z'),
          plan: {
            id: 'b538a21d-edca-45ac-8869-8da0f07e6845',
            name: 'Monthly',
            billingType: BillingType.RECURRING,
            billingInterval: BillingInterval.MONTHLY,
            intervalCount: 1,
            trialDays: 14,
          },
        },
      },
    };
  }

  async function expectUuidPipeRejectsInvalidId(
    methodName:
      | 'getStoreById'
      | 'updateStore'
      | 'updateStoreStatus'
      | 'getStoreProvisioning'
      | 'retryStoreProvisioning'
      | 'getCurrentStoreSubscription'
      | 'listStoreSubscriptions'
      | 'createStoreSubscription'
      | 'startStoreTrial',
    parameterName = 'id',
  ): Promise<void> {
    const metadata = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      AdminStoresController,
      methodName,
    ) as Record<string, { data: string; pipes: unknown[] }>;
    const idParam = Object.values(metadata).find(
      (param) => param.data === parameterName,
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
