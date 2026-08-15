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
import { StoreAuthenticationLogoutDto } from './dto/store-authentication-logout.dto';
import { StoreAuthenticationRefreshDto } from './dto/store-authentication-refresh.dto';
import { StoreAuthenticationLogoutService } from './services/store-authentication-logout.service';
import { StoreAuthenticationRefreshService } from './services/store-authentication-refresh.service';
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
const STORE_REFRESH_SUCCESS_MESSAGE =
  'Store authentication refreshed successfully';
const STORE_REFRESH_UNAVAILABLE_MESSAGE =
  'Store authentication refresh is temporarily unavailable.';
const STORE_REFRESH_FAILED_MESSAGE =
  'Store authentication refresh could not be completed.';
const STORE_LOGOUT_SUCCESS_MESSAGE = 'Store logout successful';
const STORE_LOGOUT_UNAVAILABLE_MESSAGE =
  'Store logout is temporarily unavailable.';
const STORE_LOGOUT_FAILED_MESSAGE =
  'Store logout could not be completed.';

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

export interface StoreAuthenticationRefreshHttpResponse {
  readonly success: true;
  readonly message: typeof STORE_REFRESH_SUCCESS_MESSAGE;
  readonly data: {
    readonly accessToken: string;
    readonly accessTokenExpiresAt: string;
    readonly refreshToken: string;
    readonly refreshTokenExpiresAt: string;
  };
}

export interface StoreAuthenticationLogoutHttpResponse {
  readonly success: true;
  readonly message: typeof STORE_LOGOUT_SUCCESS_MESSAGE;
  readonly data: Record<string, never>;
}

@Controller('store/auth')
export class StoreAuthController {
  constructor(
    private readonly storeOwnerLoginService: StoreOwnerLoginService,
    private readonly authenticationSessionService: StoreAuthenticationSessionService,
    private readonly authenticationRefreshService: StoreAuthenticationRefreshService,
    private readonly authenticationLogoutService: StoreAuthenticationLogoutService,
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

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async refresh(
    @Headers('x-store-slug') storeSlug: string | undefined,
    @Body() refreshDto: StoreAuthenticationRefreshDto,
  ): Promise<StoreAuthenticationRefreshHttpResponse> {
    try {
      const authenticationState =
        await this.authenticationRefreshService.refreshOwnerAuthenticationState(
          storeSlug,
          refreshDto.refreshToken,
        );

      return {
        success: true,
        message: STORE_REFRESH_SUCCESS_MESSAGE,
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
      translateStoreRefreshError(error);
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async logout(
    @Headers('x-store-slug') storeSlug: string | undefined,
    @Body() logoutDto: StoreAuthenticationLogoutDto,
  ): Promise<StoreAuthenticationLogoutHttpResponse> {
    try {
      await this.authenticationLogoutService.logoutOwnerSession(
        storeSlug,
        logoutDto.refreshToken,
      );

      return {
        success: true,
        message: STORE_LOGOUT_SUCCESS_MESSAGE,
        data: {},
      };
    } catch (error) {
      translateStoreLogoutError(error);
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

function translateStoreRefreshError(error: unknown): never {
  if (error instanceof StoreAuthError) {
    switch (error.code) {
      case StoreAuthErrorCode.STORE_SLUG_INVALID:
        throw new BadRequestException({
          success: false,
          message:
            STORE_AUTH_SAFE_MESSAGES[StoreAuthErrorCode.STORE_SLUG_INVALID],
        });
      case StoreAuthErrorCode.AUTH_REFRESH_INVALID:
      case StoreAuthErrorCode.REFRESH_TOKEN_INVALID:
      case StoreAuthErrorCode.TENANT_UNAVAILABLE:
        throw new UnauthorizedException({
          success: false,
          message:
            STORE_AUTH_SAFE_MESSAGES[StoreAuthErrorCode.AUTH_REFRESH_INVALID],
        });
      case StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID:
      case StoreAuthErrorCode.TENANT_IDENTITY_INVALID:
      case StoreAuthErrorCode.TENANT_ACCESS_FAILED:
      case StoreAuthErrorCode.TENANT_CLEANUP_FAILED:
        throw new ServiceUnavailableException({
          success: false,
          message: STORE_REFRESH_UNAVAILABLE_MESSAGE,
        });
    }
  }

  throw new InternalServerErrorException({
    success: false,
    message: STORE_REFRESH_FAILED_MESSAGE,
  });
}

function translateStoreLogoutError(error: unknown): never {
  if (error instanceof StoreAuthError) {
    switch (error.code) {
      case StoreAuthErrorCode.STORE_SLUG_INVALID:
        throw new BadRequestException({
          success: false,
          message:
            STORE_AUTH_SAFE_MESSAGES[StoreAuthErrorCode.STORE_SLUG_INVALID],
        });
      case StoreAuthErrorCode.TENANT_UNAVAILABLE:
      case StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID:
      case StoreAuthErrorCode.TENANT_IDENTITY_INVALID:
      case StoreAuthErrorCode.TENANT_ACCESS_FAILED:
      case StoreAuthErrorCode.TENANT_CLEANUP_FAILED:
        throw new ServiceUnavailableException({
          success: false,
          message: STORE_LOGOUT_UNAVAILABLE_MESSAGE,
        });
    }
  }

  throw new InternalServerErrorException({
    success: false,
    message: STORE_LOGOUT_FAILED_MESSAGE,
  });
}
