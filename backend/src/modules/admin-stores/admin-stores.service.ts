import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma, StoreStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateAdminStoreDto } from './dto/create-admin-store.dto';
import { ListAdminStoresQueryDto } from './dto/list-admin-stores-query.dto';

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

    const store = await this.prismaService.store.create({
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

    return {
      success: true,
      message: 'Store created successfully',
      data: {
        store,
      },
    };
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
}
