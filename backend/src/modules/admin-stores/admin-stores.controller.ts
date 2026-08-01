import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

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
import { CreateAdminStoreSubscriptionDto } from './dto/create-admin-store-subscription.dto';
import { CreateAdminStoreDto } from './dto/create-admin-store.dto';
import { ListAdminStoreSubscriptionsQueryDto } from './dto/list-admin-store-subscriptions-query.dto';
import { ListAdminStoresQueryDto } from './dto/list-admin-stores-query.dto';
import { StartAdminStoreTrialDto } from './dto/start-admin-store-trial.dto';
import { UpdateAdminStoreDto } from './dto/update-admin-store.dto';
import { UpdateAdminStoreStatusDto } from './dto/update-admin-store-status.dto';

@Controller('admin/stores')
@UseGuards(AdminJwtAuthGuard)
export class AdminStoresController {
  constructor(private readonly adminStoresService: AdminStoresService) {}

  @Post()
  async createStore(
    @Body() createStoreDto: CreateAdminStoreDto,
  ): Promise<AdminStoreResponse> {
    return this.adminStoresService.createStore(createStoreDto);
  }

  @Get()
  async listStores(
    @Query() query: ListAdminStoresQueryDto,
  ): Promise<AdminStoresListResponse> {
    return this.adminStoresService.listStores(query);
  }

  @Get(':id')
  async getStoreById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<AdminStoreResponse> {
    return this.adminStoresService.getStoreById(id);
  }

  @Patch(':id')
  async updateStore(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() updateStoreDto: UpdateAdminStoreDto,
  ): Promise<AdminStoreResponse> {
    return this.adminStoresService.updateStore(id, updateStoreDto);
  }

  @Patch(':id/status')
  async updateStoreStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() updateStoreStatusDto: UpdateAdminStoreStatusDto,
  ): Promise<AdminStoreResponse> {
    return this.adminStoresService.updateStoreStatus(
      id,
      updateStoreStatusDto,
    );
  }

  @Get(':storeId/provisioning')
  async getStoreProvisioning(
    @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string,
  ): Promise<AdminStoreProvisioningResponse> {
    return this.adminStoresService.getStoreProvisioning(storeId);
  }

  @Post(':storeId/provisioning/retry')
  @HttpCode(HttpStatus.OK)
  async retryStoreProvisioning(
    @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string,
  ): Promise<AdminStoreProvisioningRetryResponse> {
    return this.adminStoresService.retryStoreProvisioning(storeId);
  }

  @Get(':storeId/subscription')
  async getCurrentStoreSubscription(
    @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string,
  ): Promise<AdminStoreSubscriptionResponse> {
    return this.adminStoresService.getCurrentStoreSubscription(storeId);
  }

  @Get(':storeId/subscriptions')
  async listStoreSubscriptions(
    @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string,
    @Query() query: ListAdminStoreSubscriptionsQueryDto,
  ): Promise<AdminStoreSubscriptionsListResponse> {
    return this.adminStoresService.listStoreSubscriptions(storeId, query);
  }

  @Post(':storeId/subscriptions')
  async createStoreSubscription(
    @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string,
    @Body() createSubscriptionDto: CreateAdminStoreSubscriptionDto,
  ): Promise<AdminStoreSubscriptionResponse> {
    return this.adminStoresService.createStoreSubscription(
      storeId,
      createSubscriptionDto,
    );
  }

  @Post(':storeId/subscriptions/trial')
  async startStoreTrial(
    @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string,
    @Body() startTrialDto: StartAdminStoreTrialDto,
  ): Promise<AdminStoreSubscriptionResponse> {
    return this.adminStoresService.startStoreTrial(storeId, startTrialDto);
  }
}
