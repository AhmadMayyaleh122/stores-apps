import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

import { TENANT_OWNER_EMAIL_MAX_LENGTH } from '../../tenant-provisioning/utils/tenant-owner-email.util';

export const STORE_OWNER_LOGIN_PASSWORD_HTTP_MAX_LENGTH = 256;

export class StoreOwnerLoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(TENANT_OWNER_EMAIL_MAX_LENGTH)
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(STORE_OWNER_LOGIN_PASSWORD_HTTP_MAX_LENGTH)
  password: string;
}
