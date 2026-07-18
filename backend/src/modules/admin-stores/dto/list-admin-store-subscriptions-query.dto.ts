import { IsEnum, IsOptional } from 'class-validator';

import { SubscriptionStatus } from '../../../../generated/prisma/client';

export class ListAdminStoreSubscriptionsQueryDto {
  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;
}
