import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export const STORE_AUTH_REFRESH_TOKEN_HTTP_MAX_LENGTH = 256;

export class StoreAuthenticationRefreshDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(STORE_AUTH_REFRESH_TOKEN_HTTP_MAX_LENGTH)
  refreshToken: string;
}
