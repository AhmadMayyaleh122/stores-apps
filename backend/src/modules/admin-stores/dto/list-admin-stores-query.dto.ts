import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { StoreStatus } from '../../../../generated/prisma/client';

export class ListAdminStoresQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  @IsOptional()
  @IsEnum(StoreStatus)
  status?: StoreStatus;
}
