import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
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
  TenantProvisioningError,
  TenantProvisioningErrorCode,
  getTenantProvisioningSafeMessage,
} from '../tenant-provisioning/tenant-provisioning.errors';
import {
  TenantProvisioningResult,
  TenantProvisioningService,
} from '../tenant-provisioning/tenant-provisioning.service';
import { TenantProvisioningPublicRecord } from '../tenant-provisioning/tenant-provisioning.select';
import { CreateAdminStoreSubscriptionDto } from './dto/create-admin-store-subscription.dto';
import { CreateAdminStoreDto } from './dto/create-admin-store.dto';
import { ListAdminStoreSubscriptionsQueryDto } from './dto/list-admin-store-subscriptions-query.dto';
import { ListAdminStoresQueryDto } from './dto/list-admin-stores-query.dto';
import { StartAdminStoreTrialDto } from './dto/start-admin-store-trial.dto';
import { UpdateAdminStoreDto } from './dto/update-admin-store.dto';
import { UpdateAdminStoreStatusDto } from './dto/update-admin-store-status.dto';

const adminStoreSelect = {
  id: true,
  storeName: true,
  storeSlug: true,
  ownerName: true,
  ownerEmail: true,
  ownerPhone: true,
  status: true,
  subscriptionPlanId: true,
  databaseName: true,
  logoUrl: true,
  primaryColor: true,
  secondaryColor: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.StoreSelect;

const currentOperationalSubscriptionStatuses = [
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.LIFETIME,
] satisfies SubscriptionStatus[];

const adminStoreSubscriptionSelect = {
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
} satisfies Prisma.BillingSubscriptionSelect;

const subscriptionPlanSelect = {
  id: true,
  price: true,
  billingType: true,
  billingInterval: true,
  intervalCount: true,
  trialDays: true,
} satisfies Prisma.SubscriptionPlanSelect;

type AdminStore = Prisma.StoreGetPayload<{
  select: typeof adminStoreSelect;
}>;

type AdminStoreSubscription = Prisma.BillingSubscriptionGetPayload<{
  select: typeof adminStoreSubscriptionSelect;
}>;

type SubscriptionPlanForAssignment = Prisma.SubscriptionPlanGetPayload<{
  select: typeof subscriptionPlanSelect;
}>;

export interface AdminStoreResponse {
  success: true;
  message: string;
  data: {
    store: AdminStore;
  };
}

export interface AdminStoresListResponse {
  success: true;
  message: string;
  data: {
    stores: AdminStore[];
  };
}

export interface AdminStoreSubscriptionResponse {
  success: true;
  message: string;
  data: {
    subscription: AdminStoreSubscription;
  };
}

export interface AdminStoreSubscriptionsListResponse {
  success: true;
  message: string;
  data: {
    subscriptions: AdminStoreSubscription[];
  };
}

export interface AdminStoreProvisioningResponse {
  success: true;
  message: string;
  data: {
    provisioning: TenantProvisioningPublicRecord;
  };
}

export interface AdminStoreProvisioningRetryResponse
  extends AdminStoreProvisioningResponse {
  data: {
    provisioning: TenantProvisioningPublicRecord;
    alreadyReady: boolean;
  };
}

@Injectable()
export class AdminStoresService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly tenantProvisioningService: TenantProvisioningService,
  ) {}

  async createStore(
    createStoreDto: CreateAdminStoreDto,
  ): Promise<AdminStoreResponse> {
    const storeSlug = createStoreDto.storeSlug.trim().toLowerCase();

    const existingStore = await this.prismaService.store.findFirst({
      where: {
        OR: [
          { storeSlug },
          ...(createStoreDto.databaseName
            ? [{ databaseName: createStoreDto.databaseName }]
            : []),
        ],
      },
      select: {
        storeSlug: true,
        databaseName: true,
      },
    });

    if (existingStore?.storeSlug === storeSlug) {
      throw new ConflictException({
        success: false,
        message: 'Store slug already exists',
      });
    }

    if (
      createStoreDto.databaseName &&
      existingStore?.databaseName === createStoreDto.databaseName
    ) {
      throw new ConflictException({
        success: false,
        message: 'Store database name already exists',
      });
    }

    const store = await this.createStoreRecord(createStoreDto, storeSlug);
    await this.provisionTenantStore(store.id);

    return {
      success: true,
      message: 'Store created successfully',
      data: {
        store,
      },
    };
  }

  async getStoreProvisioning(
    storeId: string,
  ): Promise<AdminStoreProvisioningResponse> {
    try {
      const provisioning =
        await this.tenantProvisioningService.getProvisioningStatus(storeId);

      return {
        success: true,
        message: 'Store provisioning status retrieved successfully',
        data: { provisioning },
      };
    } catch (error) {
      this.handleTenantProvisioningError(error);
    }
  }

  async retryStoreProvisioning(
    storeId: string,
  ): Promise<AdminStoreProvisioningRetryResponse> {
    try {
      const result =
        await this.tenantProvisioningService.provisionStore(storeId);
      this.assertProvisioningReady(result);

      return {
        success: true,
        message: result.alreadyReady
          ? 'Store provisioning is already complete'
          : 'Store provisioning completed successfully',
        data: result,
      };
    } catch (error) {
      this.handleTenantProvisioningError(error);
    }
  }

  private async provisionTenantStore(storeId: string): Promise<void> {
    try {
      const result =
        await this.tenantProvisioningService.provisionStore(storeId);
      this.assertProvisioningReady(result);
    } catch (error) {
      this.handleTenantProvisioningError(error);
    }
  }

  private assertProvisioningReady(result: TenantProvisioningResult): void {
    if (result.provisioning.status !== TenantProvisioningStatus.READY) {
      throw new ConflictException({
        success: false,
        message: getTenantProvisioningSafeMessage(
          TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
        ),
        code: TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
      });
    }
  }

  private handleTenantProvisioningError(error: unknown): never {
    if (error instanceof HttpException) {
      throw error;
    }

    if (!(error instanceof TenantProvisioningError)) {
      throw new InternalServerErrorException({
        success: false,
        message: getTenantProvisioningSafeMessage(
          TenantProvisioningErrorCode.PROVISIONING_FAILED,
        ),
        code: TenantProvisioningErrorCode.PROVISIONING_FAILED,
      });
    }

    const response = {
      success: false,
      message: getTenantProvisioningSafeMessage(error.code),
      code: error.code,
    };

    switch (error.code) {
      case TenantProvisioningErrorCode.STORE_NOT_FOUND:
      case TenantProvisioningErrorCode.PROVISIONING_NOT_FOUND:
        throw new NotFoundException(response);
      case TenantProvisioningErrorCode.IDENTIFIER_INVALID:
        throw new BadRequestException(response);
      case TenantProvisioningErrorCode.ROLE_CONFLICT:
      case TenantProvisioningErrorCode.DATABASE_OWNER_CONFLICT:
      case TenantProvisioningErrorCode.IDENTITY_MISMATCH:
      case TenantProvisioningErrorCode.IDENTIFIER_CONFLICT:
      case TenantProvisioningErrorCode.RECORD_INTEGRITY_FAILED:
      case TenantProvisioningErrorCode.CONFIGURATION_DRIFT:
      case TenantProvisioningErrorCode.PROVISIONING_IN_PROGRESS:
      case TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT:
        throw new ConflictException(response);
      case TenantProvisioningErrorCode.CONFIGURATION_INVALID:
      case TenantProvisioningErrorCode.ENCRYPTION_KEY_INVALID:
      case TenantProvisioningErrorCode.DATABASE_URL_INVALID:
      case TenantProvisioningErrorCode.POSTGRES_ADMIN_UNAVAILABLE:
      case TenantProvisioningErrorCode.ROLE_PROVISIONING_FAILED:
      case TenantProvisioningErrorCode.DATABASE_PROVISIONING_FAILED:
      case TenantProvisioningErrorCode.MIGRATION_FAILED:
      case TenantProvisioningErrorCode.IDENTITY_INITIALIZATION_FAILED:
      case TenantProvisioningErrorCode.VERIFICATION_FAILED:
      case TenantProvisioningErrorCode.PROVISIONING_FAILED:
        throw new ServiceUnavailableException(response);
      case TenantProvisioningErrorCode.CREDENTIAL_ENCRYPTION_FAILED:
      case TenantProvisioningErrorCode.CREDENTIAL_DECRYPTION_FAILED:
      case TenantProvisioningErrorCode.IDENTITY_CLEANUP_FAILED:
        throw new InternalServerErrorException(response);
    }
  }

  private async createStoreRecord(
    createStoreDto: CreateAdminStoreDto,
    storeSlug: string,
  ): Promise<AdminStore> {
    try {
      return await this.prismaService.store.create({
        data: {
          storeName: createStoreDto.storeName,
          storeSlug,
          ownerName: createStoreDto.ownerName,
          ownerEmail: createStoreDto.ownerEmail,
          ownerPhone: createStoreDto.ownerPhone,
          status: createStoreDto.status ?? StoreStatus.TRIAL,
          databaseName: createStoreDto.databaseName,
          logoUrl: createStoreDto.logoUrl,
          primaryColor: createStoreDto.primaryColor,
          secondaryColor: createStoreDto.secondaryColor,
        },
        select: adminStoreSelect,
      });
    } catch (error) {
      this.handleStoreMutationError(error);
    }
  }

  async listStores(
    query: ListAdminStoresQueryDto,
  ): Promise<AdminStoresListResponse> {
    const where = this.buildListWhere(query);

    const stores = await this.prismaService.store.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
      select: adminStoreSelect,
    });

    return {
      success: true,
      message: 'Stores retrieved successfully',
      data: {
        stores,
      },
    };
  }

  async getStoreById(id: string): Promise<AdminStoreResponse> {
    const store = await this.prismaService.store.findUnique({
      where: { id },
      select: adminStoreSelect,
    });

    if (!store) {
      throw new NotFoundException({
        success: false,
        message: 'Store not found',
      });
    }

    return {
      success: true,
      message: 'Store retrieved successfully',
      data: {
        store,
      },
    };
  }

  async updateStore(
    id: string,
    updateStoreDto: UpdateAdminStoreDto,
  ): Promise<AdminStoreResponse> {
    this.assertUpdateHasFields(updateStoreDto);

    await this.findStoreIdentityOrThrow(id);
    const storeSlug =
      updateStoreDto.storeSlug === undefined
        ? undefined
        : updateStoreDto.storeSlug.trim().toLowerCase();

    await this.assertUniqueUpdateFields(id, {
      storeSlug,
      databaseName: updateStoreDto.databaseName,
    });

    const store = await this.updateStoreRecord(id, {
      ...updateStoreDto,
      storeSlug,
    });

    return {
      success: true,
      message: 'Store updated successfully',
      data: {
        store,
      },
    };
  }

  async updateStoreStatus(
    id: string,
    updateStoreStatusDto: UpdateAdminStoreStatusDto,
  ): Promise<AdminStoreResponse> {
    await this.findStoreIdentityOrThrow(id);

    const store = await this.updateStoreRecord(id, {
      status: updateStoreStatusDto.status,
    });

    return {
      success: true,
      message: 'Store status updated successfully',
      data: {
        store,
      },
    };
  }

  async getCurrentStoreSubscription(
    storeId: string,
  ): Promise<AdminStoreSubscriptionResponse> {
    await this.assertStoreExists(storeId);

    const subscription =
      await this.prismaService.billingSubscription.findFirst({
        where: {
          storeId,
          status: {
            in: currentOperationalSubscriptionStatuses,
          },
        },
        select: adminStoreSubscriptionSelect,
      });

    if (!subscription) {
      throw new NotFoundException({
        success: false,
        message: 'Current store subscription not found',
      });
    }

    return {
      success: true,
      message: 'Current store subscription retrieved successfully',
      data: {
        subscription,
      },
    };
  }

  async listStoreSubscriptions(
    storeId: string,
    query: ListAdminStoreSubscriptionsQueryDto,
  ): Promise<AdminStoreSubscriptionsListResponse> {
    await this.assertStoreExists(storeId);

    const subscriptions =
      await this.prismaService.billingSubscription.findMany({
        where: {
          storeId,
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
        select: adminStoreSubscriptionSelect,
      });

    return {
      success: true,
      message: 'Store subscription history retrieved successfully',
      data: {
        subscriptions,
      },
    };
  }

  async createStoreSubscription(
    storeId: string,
    dto: CreateAdminStoreSubscriptionDto,
  ): Promise<AdminStoreSubscriptionResponse> {
    await this.assertStoreExists(storeId);
    const plan = await this.findSubscriptionPlanOrThrow(dto.planId);

    if (plan.billingType === BillingType.TRIAL) {
      throw new BadRequestException({
        success: false,
        message: 'Trial plans must use the trial subscription endpoint',
      });
    }

    const startDate = this.parseSubscriptionDate(dto.startDate, 'startDate');
    const requestedEndDate = dto.endDate
      ? this.parseSubscriptionDate(dto.endDate, 'endDate')
      : null;
    const { endDate, status } = this.resolveNormalSubscriptionPeriod(
      plan,
      startDate,
      requestedEndDate,
    );

    await this.assertNoCurrentSubscription(storeId);

    const subscription = await this.createSubscriptionTransaction(
      {
        storeId,
        planId: plan.id,
        startDate,
        endDate,
        status,
        isTrial: false,
        amount: plan.price,
      },
      StoreStatus.ACTIVE,
    );

    return {
      success: true,
      message: 'Store subscription created successfully',
      data: {
        subscription,
      },
    };
  }

  async startStoreTrial(
    storeId: string,
    dto: StartAdminStoreTrialDto,
  ): Promise<AdminStoreSubscriptionResponse> {
    await this.assertStoreExists(storeId);
    const plan = await this.findSubscriptionPlanOrThrow(dto.planId);

    if (
      plan.billingType !== BillingType.TRIAL &&
      !(plan.trialDays && plan.trialDays > 0)
    ) {
      throw new BadRequestException({
        success: false,
        message: 'Subscription plan is not eligible for a trial',
      });
    }

    if (dto.endDate !== undefined && dto.trialDays !== undefined) {
      throw new BadRequestException({
        success: false,
        message: 'Provide either endDate or trialDays, not both',
      });
    }

    const startDate = this.parseSubscriptionDate(dto.startDate, 'startDate');
    const endDate = this.resolveTrialEndDate(dto, plan, startDate);

    await this.assertTrialNotPreviouslyUsed(storeId);
    await this.assertNoCurrentSubscription(storeId);

    const subscription = await this.createSubscriptionTransaction(
      {
        storeId,
        planId: plan.id,
        startDate,
        endDate,
        status: SubscriptionStatus.TRIALING,
        isTrial: true,
        amount: new Prisma.Decimal(0),
      },
      StoreStatus.TRIAL,
    );

    return {
      success: true,
      message: 'Store trial started successfully',
      data: {
        subscription,
      },
    };
  }

  private async assertStoreExists(storeId: string): Promise<void> {
    const store = await this.prismaService.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });

    if (!store) {
      throw new NotFoundException({
        success: false,
        message: 'Store not found',
      });
    }
  }

  private async findSubscriptionPlanOrThrow(
    planId: string,
  ): Promise<SubscriptionPlanForAssignment> {
    const plan = await this.prismaService.subscriptionPlan.findUnique({
      where: { id: planId },
      select: subscriptionPlanSelect,
    });

    if (!plan) {
      throw new NotFoundException({
        success: false,
        message: 'Subscription plan not found',
      });
    }

    return plan;
  }

  private async assertNoCurrentSubscription(storeId: string): Promise<void> {
    const currentSubscription =
      await this.prismaService.billingSubscription.findFirst({
        where: {
          storeId,
          status: {
            in: currentOperationalSubscriptionStatuses,
          },
        },
        select: { id: true },
      });

    if (currentSubscription) {
      throw new ConflictException({
        success: false,
        message: 'Store already has a current operational subscription',
      });
    }
  }

  private async assertTrialNotPreviouslyUsed(storeId: string): Promise<void> {
    const previousTrial =
      await this.prismaService.billingSubscription.findFirst({
        where: {
          storeId,
          isTrial: true,
        },
        select: { id: true },
      });

    if (previousTrial) {
      throw new ConflictException({
        success: false,
        message: 'Store has already used a trial subscription',
      });
    }
  }

  private parseSubscriptionDate(value: string | undefined, field: string): Date {
    if (value === undefined) {
      return new Date();
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException({
        success: false,
        message: `${field} must be a valid ISO-8601 date`,
      });
    }

    return date;
  }

  private resolveNormalSubscriptionPeriod(
    plan: SubscriptionPlanForAssignment,
    startDate: Date,
    requestedEndDate: Date | null,
  ): { endDate: Date | null; status: SubscriptionStatus } {
    if (requestedEndDate && requestedEndDate <= startDate) {
      throw new BadRequestException({
        success: false,
        message: 'endDate must be strictly later than startDate',
      });
    }

    if (
      plan.billingType === BillingType.RECURRING &&
      plan.billingInterval === BillingInterval.NONE
    ) {
      throw new BadRequestException({
        success: false,
        message: 'Recurring plans must define a billing interval',
      });
    }

    if (
      plan.billingInterval === BillingInterval.CUSTOM &&
      requestedEndDate === null
    ) {
      throw new BadRequestException({
        success: false,
        message: 'endDate is required for custom billing intervals',
      });
    }

    if (
      plan.billingType === BillingType.ONE_TIME &&
      plan.billingInterval === BillingInterval.NONE &&
      requestedEndDate === null
    ) {
      return {
        endDate: null,
        status: SubscriptionStatus.LIFETIME,
      };
    }

    let endDate = requestedEndDate;

    if (
      endDate === null &&
      (plan.billingInterval === BillingInterval.MONTHLY ||
        plan.billingInterval === BillingInterval.YEARLY)
    ) {
      if (plan.intervalCount < 1) {
        throw new BadRequestException({
          success: false,
          message: 'Subscription plan intervalCount must be positive',
        });
      }

      endDate =
        plan.billingInterval === BillingInterval.MONTHLY
          ? this.addUtcCalendarMonths(startDate, plan.intervalCount)
          : this.addUtcCalendarYears(startDate, plan.intervalCount);
    }

    return {
      endDate,
      status: SubscriptionStatus.ACTIVE,
    };
  }

  private resolveTrialEndDate(
    dto: StartAdminStoreTrialDto,
    plan: SubscriptionPlanForAssignment,
    startDate: Date,
  ): Date {
    let endDate: Date;

    if (dto.endDate !== undefined) {
      endDate = this.parseSubscriptionDate(dto.endDate, 'endDate');
    } else {
      const trialDays = dto.trialDays ?? plan.trialDays;

      if (!trialDays || trialDays < 1) {
        throw new BadRequestException({
          success: false,
          message: 'A positive trial duration is required',
        });
      }

      endDate = new Date(startDate);
      endDate.setUTCDate(endDate.getUTCDate() + trialDays);
    }

    if (endDate <= startDate) {
      throw new BadRequestException({
        success: false,
        message: 'endDate must be strictly later than startDate',
      });
    }

    return endDate;
  }

  private addUtcCalendarMonths(date: Date, months: number): Date {
    const result = new Date(date);
    const requestedDay = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDayOfTargetMonth = new Date(
      Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
    ).getUTCDate();
    result.setUTCDate(Math.min(requestedDay, lastDayOfTargetMonth));

    return result;
  }

  private addUtcCalendarYears(date: Date, years: number): Date {
    const result = new Date(date);
    const requestedMonth = result.getUTCMonth();
    const requestedDay = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCFullYear(result.getUTCFullYear() + years);
    result.setUTCMonth(requestedMonth);
    const lastDayOfTargetMonth = new Date(
      Date.UTC(result.getUTCFullYear(), requestedMonth + 1, 0),
    ).getUTCDate();
    result.setUTCDate(Math.min(requestedDay, lastDayOfTargetMonth));

    return result;
  }

  private async createSubscriptionTransaction(
    data: Prisma.BillingSubscriptionUncheckedCreateInput,
    storeStatus: StoreStatus,
  ): Promise<AdminStoreSubscription> {
    try {
      return await this.prismaService.$transaction(async (tx) => {
        const subscription = await tx.billingSubscription.create({
          data,
          select: adminStoreSubscriptionSelect,
        });

        await tx.store.update({
          where: { id: data.storeId },
          data: {
            subscriptionPlanId: data.planId,
            status: storeStatus,
          },
          select: { id: true },
        });

        return subscription;
      });
    } catch (error) {
      this.handleSubscriptionMutationError(error);
    }
  }

  private handleSubscriptionMutationError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        if (!this.isCurrentSubscriptionUniqueConflict(error)) {
          throw new ConflictException({
            success: false,
            message: 'Subscription already exists',
          });
        }

        throw new ConflictException({
          success: false,
          message: 'Store already has a current operational subscription',
        });
      }

      if (error.code === 'P2003') {
        throw new BadRequestException({
          success: false,
          message: 'Invalid store or subscription plan relation',
        });
      }

      if (error.code === 'P2025') {
        throw new NotFoundException({
          success: false,
          message: 'Store or subscription plan not found',
        });
      }
    }

    throw error;
  }

  private isCurrentSubscriptionUniqueConflict(
    error: Prisma.PrismaClientKnownRequestError,
  ): boolean {
    const target = error.meta?.target;
    const constraint = error.meta?.constraint;
    const identifiers = [
      ...(Array.isArray(target) ? target : [target]),
      ...(Array.isArray(constraint) ? constraint : [constraint]),
    ];

    return identifiers.some(
      (identifier) =>
        identifier === 'storeId' ||
        identifier === 'store_id' ||
        identifier === 'billing_subscriptions_one_current_per_store_uidx',
    );
  }

  private buildListWhere(
    query: ListAdminStoresQueryDto,
  ): Prisma.StoreWhereInput {
    const where: Prisma.StoreWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.search) {
      where.OR = [
        { storeName: { contains: query.search, mode: 'insensitive' } },
        { storeSlug: { contains: query.search, mode: 'insensitive' } },
        { ownerName: { contains: query.search, mode: 'insensitive' } },
        { ownerEmail: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  private assertUpdateHasFields(updateStoreDto: UpdateAdminStoreDto): void {
    const hasUpdateFields = Object.values(updateStoreDto).some(
      (value) => value !== undefined,
    );

    if (!hasUpdateFields) {
      throw new BadRequestException({
        success: false,
        message: 'Update body must contain at least one field',
      });
    }
  }

  private async findStoreIdentityOrThrow(
    id: string,
  ): Promise<Pick<AdminStore, 'id' | 'storeSlug' | 'databaseName'>> {
    const store = await this.prismaService.store.findUnique({
      where: { id },
      select: {
        id: true,
        storeSlug: true,
        databaseName: true,
      },
    });

    if (!store) {
      throw new NotFoundException({
        success: false,
        message: 'Store not found',
      });
    }

    return store;
  }

  private async assertUniqueUpdateFields(
    id: string,
    fields: Pick<UpdateAdminStoreDto, 'storeSlug' | 'databaseName'>,
  ): Promise<void> {
    const filters: Prisma.StoreWhereInput[] = [];

    if (fields.storeSlug) {
      filters.push({ storeSlug: fields.storeSlug });
    }

    if (fields.databaseName) {
      filters.push({ databaseName: fields.databaseName });
    }

    if (filters.length === 0) {
      return;
    }

    const duplicateStore = await this.prismaService.store.findFirst({
      where: {
        id: {
          not: id,
        },
        OR: filters,
      },
      select: {
        storeSlug: true,
        databaseName: true,
      },
    });

    if (duplicateStore?.storeSlug === fields.storeSlug) {
      throw new ConflictException({
        success: false,
        message: 'Store slug already exists',
      });
    }

    if (
      fields.databaseName &&
      duplicateStore?.databaseName === fields.databaseName
    ) {
      throw new ConflictException({
        success: false,
        message: 'Store database name already exists',
      });
    }
  }

  private async updateStoreRecord(
    id: string,
    updateStoreDto: UpdateAdminStoreDto | UpdateAdminStoreStatusDto,
  ): Promise<AdminStore> {
    try {
      return await this.prismaService.store.update({
        where: { id },
        data: this.buildStoreUpdateData(updateStoreDto),
        select: adminStoreSelect,
      });
    } catch (error) {
      this.handleStoreMutationError(error);
    }
  }

  private buildStoreUpdateData(
    updateStoreDto: UpdateAdminStoreDto | UpdateAdminStoreStatusDto,
  ): Prisma.StoreUncheckedUpdateInput {
    const dto = updateStoreDto as UpdateAdminStoreDto &
      Partial<UpdateAdminStoreStatusDto>;
    const data: Prisma.StoreUncheckedUpdateInput = {};

    if (dto.storeName !== undefined) {
      data.storeName = dto.storeName;
    }

    if (dto.storeSlug !== undefined) {
      data.storeSlug = dto.storeSlug;
    }

    if (dto.ownerName !== undefined) {
      data.ownerName = dto.ownerName;
    }

    if (dto.ownerEmail !== undefined) {
      data.ownerEmail = dto.ownerEmail;
    }

    if (dto.ownerPhone !== undefined) {
      data.ownerPhone = dto.ownerPhone;
    }

    if (dto.databaseName !== undefined) {
      data.databaseName = dto.databaseName;
    }

    if (dto.logoUrl !== undefined) {
      data.logoUrl = dto.logoUrl;
    }

    if (dto.primaryColor !== undefined) {
      data.primaryColor = dto.primaryColor;
    }

    if (dto.secondaryColor !== undefined) {
      data.secondaryColor = dto.secondaryColor;
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
    }

    return data;
  }

  private handleStoreMutationError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException({
          success: false,
          message: this.getUniqueConflictMessage(error),
        });
      }

      if (error.code === 'P2025') {
        throw new NotFoundException({
          success: false,
          message: 'Store not found',
        });
      }
    }

    throw error;
  }

  private getUniqueConflictMessage(
    error: Prisma.PrismaClientKnownRequestError,
  ): string {
    const target = error.meta?.target;
    const targetFields = Array.isArray(target) ? target : [target];

    if (
      targetFields.some(
        (field) => field === 'databaseName' || field === 'database_name',
      )
    ) {
      return 'Store database name already exists';
    }

    return 'Store slug already exists';
  }
}
