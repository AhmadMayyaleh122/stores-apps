import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { StoreOwnerLoginDto } from './dto/store-owner-login.dto';
import { StoreAuthenticationSessionService } from './services/store-authentication-session.service';
import { StoreOwnerLoginService } from './services/store-owner-login.service';
import {
  STORE_AUTH_SAFE_MESSAGES,
  StoreAuthError,
  StoreAuthErrorCode,
} from './store-auth.errors';

const STORE_LOGIN_SUCCESS_MESSAGE = 'Store owner login successful';
const STORE_LOGIN_UNAVAILABLE_MESSAGE =
  'Store login is temporarily unavailable.';
const STORE_LOGIN_FAILED_MESSAGE = 'Store login could not be completed.';

export interface StoreOwnerLoginHttpResponse {
  readonly success: true;
  readonly message: typeof STORE_LOGIN_SUCCESS_MESSAGE;
  readonly data: {
    readonly accessToken: string;
    readonly accessTokenExpiresAt: string;
    readonly refreshToken: string;
    readonly refreshTokenExpiresAt: string;
  };
}

@Controller('store/auth')
export class StoreAuthController {
  constructor(
    private readonly storeOwnerLoginService: StoreOwnerLoginService,
    private readonly authenticationSessionService: StoreAuthenticationSessionService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async login(
    @Headers('x-store-slug') storeSlug: string | undefined,
    @Body() loginDto: StoreOwnerLoginDto,
  ): Promise<StoreOwnerLoginHttpResponse> {
    try {
      const authenticatedOwner =
        await this.storeOwnerLoginService.authenticateOwner(
          storeSlug,
          loginDto.email,
          loginDto.password,
        );
      const authenticationState =
        await this.authenticationSessionService.createOwnerAuthenticationState(
          storeSlug,
          authenticatedOwner,
        );

      return {
        success: true,
        message: STORE_LOGIN_SUCCESS_MESSAGE,
        data: {
          accessToken: authenticationState.accessToken,
          accessTokenExpiresAt:
            authenticationState.accessTokenExpiresAt.toISOString(),
          refreshToken: authenticationState.refreshToken,
          refreshTokenExpiresAt:
            authenticationState.refreshTokenExpiresAt.toISOString(),
        },
      };
    } catch (error) {
      translateStoreLoginError(error);
    }
  }
}

function translateStoreLoginError(error: unknown): never {
  if (error instanceof StoreAuthError) {
    switch (error.code) {
      case StoreAuthErrorCode.STORE_SLUG_INVALID:
        throw new BadRequestException({
          success: false,
          message:
            STORE_AUTH_SAFE_MESSAGES[StoreAuthErrorCode.STORE_SLUG_INVALID],
        });
      case StoreAuthErrorCode.INVALID_STORE_CREDENTIALS:
      case StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID:
      case StoreAuthErrorCode.TENANT_UNAVAILABLE:
        throw new UnauthorizedException({
          success: false,
          message:
            STORE_AUTH_SAFE_MESSAGES[
              StoreAuthErrorCode.INVALID_STORE_CREDENTIALS
            ],
        });
      case StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID:
      case StoreAuthErrorCode.TENANT_IDENTITY_INVALID:
      case StoreAuthErrorCode.TENANT_ACCESS_FAILED:
      case StoreAuthErrorCode.TENANT_CLEANUP_FAILED:
        throw new ServiceUnavailableException({
          success: false,
          message: STORE_LOGIN_UNAVAILABLE_MESSAGE,
        });
    }
  }

  throw new InternalServerErrorException({
    success: false,
    message: STORE_LOGIN_FAILED_MESSAGE,
  });
}
