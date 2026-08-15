import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { AdminStoresModule } from './modules/admin-stores/admin-stores.module';
import { StoreAuthModule } from './modules/store-auth/store-auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HealthModule,
    AdminAuthModule,
    AdminStoresModule,
    StoreAuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
