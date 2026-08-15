import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { STORE_AUTH_REFRESH_TOKEN_HTTP_MAX_LENGTH } from './store-authentication-refresh.dto';

export class StoreAuthenticationLogoutDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(STORE_AUTH_REFRESH_TOKEN_HTTP_MAX_LENGTH)
  refreshToken: string;
}
