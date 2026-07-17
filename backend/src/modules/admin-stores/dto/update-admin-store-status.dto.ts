import { IsEnum } from 'class-validator';

import { StoreStatus } from '../../../../generated/prisma/client';

export class UpdateAdminStoreStatusDto {
  @IsEnum(StoreStatus)
  status: StoreStatus;
}
