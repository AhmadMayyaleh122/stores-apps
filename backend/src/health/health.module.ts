import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { DatabaseHealthController } from './database-health.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [DatabaseHealthController],
})
export class HealthModule {}
