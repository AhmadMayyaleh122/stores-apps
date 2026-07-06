import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AdminJwtAuthGuard } from '../admin-auth/guards/admin-jwt-auth.guard';
import {
  AdminStoreResponse,
  AdminStoresListResponse,
  AdminStoresService,
} from './admin-stores.service';
import { CreateAdminStoreDto } from './dto/create-admin-store.dto';
import { ListAdminStoresQueryDto } from './dto/list-admin-stores-query.dto';

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
}
