import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { DatabaseModule } from '../../database/database.module';
import { AdminJwtAuthGuard } from '../admin-auth/guards/admin-jwt-auth.guard';
import { AdminStoresController } from './admin-stores.controller';
import { AdminStoresService } from './admin-stores.service';

@Module({
  imports: [DatabaseModule, JwtModule.register({})],
  controllers: [AdminStoresController],
  providers: [AdminStoresService, AdminJwtAuthGuard],
})
export class AdminStoresModule {}
