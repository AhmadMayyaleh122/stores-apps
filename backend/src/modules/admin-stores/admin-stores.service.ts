import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma, StoreStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateAdminStoreDto } from './dto/create-admin-store.dto';
import { ListAdminStoresQueryDto } from './dto/list-admin-stores-query.dto';
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

type AdminStore = Prisma.StoreGetPayload<{
  select: typeof adminStoreSelect;
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

@Injectable()
export class AdminStoresService {
  constructor(private readonly prismaService: PrismaService) {}

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

    return {
      success: true,
      message: 'Store created successfully',
      data: {
        store,
      },
    };
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
          subscriptionPlanId: createStoreDto.subscriptionPlanId,
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

    if (dto.subscriptionPlanId !== undefined) {
      data.subscriptionPlanId = dto.subscriptionPlanId;
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

      if (error.code === 'P2003') {
        throw new BadRequestException({
          success: false,
          message: 'Invalid subscription plan id',
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
