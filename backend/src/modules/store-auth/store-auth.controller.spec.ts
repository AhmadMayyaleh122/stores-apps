import {
  BadRequestException,
  HttpStatus,
  InternalServerErrorException,
  RequestMethod,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import {
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PARAMTYPES_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';

import { StoreOwnerLoginDto } from './dto/store-owner-login.dto';
import { StoreAuthenticationRefreshDto } from './dto/store-authentication-refresh.dto';
import { RefreshTokenService } from './services/refresh-token.service';
import { StoreAccessTokenService } from './services/store-access-token.service';
import { StoreAuthenticationRefreshService } from './services/store-authentication-refresh.service';
import { StoreAuthenticationSessionService } from './services/store-authentication-session.service';
import { StoreOwnerLoginService } from './services/store-owner-login.service';
import {
  StoreAuthController,
  StoreAuthenticationRefreshHttpResponse,
  StoreOwnerLoginHttpResponse,
} from './store-auth.controller';
import {
  StoreAuthError,
  StoreAuthErrorCode,
} from './store-auth.errors';

describe('StoreAuthController', () => {
  const storeSlug = 'demo-store';
  const owner = Object.freeze({
    storeId: '12345678-1234-4234-8123-456789012345',
    ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'owner@example.com',
  });
  const loginDto: StoreOwnerLoginDto = {
    email: 'Owner@Example.COM',
    password: 'correct horse battery staple',
  };
  const authenticationState = Object.freeze({
    accessToken: 'signed.access.token',
    accessTokenExpiresAt: new Date('2026-08-15T12:15:00.000Z'),
    refreshToken: `srt_${Buffer.alloc(32, 7).toString('base64url')}`,
    refreshTokenExpiresAt: new Date('2026-09-14T12:00:00.000Z'),
  });
  const refreshDto: StoreAuthenticationRefreshDto = {
    refreshToken: authenticationState.refreshToken,
  };
  let authenticateOwner: jest.Mock;
  let createOwnerAuthenticationState: jest.Mock;
  let refreshOwnerAuthenticationState: jest.Mock;
  let controller: StoreAuthController;

  beforeEach(() => {
    authenticateOwner = jest.fn().mockResolvedValue(owner);
    createOwnerAuthenticationState = jest
      .fn()
      .mockResolvedValue(authenticationState);
    refreshOwnerAuthenticationState = jest
      .fn()
      .mockResolvedValue(authenticationState);
    controller = new StoreAuthController(
      { authenticateOwner } as unknown as StoreOwnerLoginService,
      {
        createOwnerAuthenticationState,
      } as unknown as StoreAuthenticationSessionService,
      {
        refreshOwnerAuthenticationState,
      } as unknown as StoreAuthenticationRefreshService,
    );
  });

  it('exposes POST /store/auth/login as HTTP 200 with no-store headers', () => {
    const handler = StoreAuthController.prototype.login;

    expect(Reflect.getMetadata(PATH_METADATA, StoreAuthController)).toBe(
      'store/auth',
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('login');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
      HttpStatus.OK,
    );
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([
      { name: 'Pragma', value: 'no-cache' },
      { name: 'Cache-Control', value: 'no-store' },
    ]);
  });

  it('depends only on the three Store Auth orchestration services', () => {
    const dependencies = Reflect.getMetadata(
      PARAMTYPES_METADATA,
      StoreAuthController,
    );

    expect(dependencies).toEqual([
      StoreOwnerLoginService,
      StoreAuthenticationSessionService,
      StoreAuthenticationRefreshService,
    ]);
    expect(dependencies).not.toContain(RefreshTokenService);
    expect(dependencies).not.toContain(StoreAccessTokenService);
  });

  it('authenticates once, creates one session, and returns only public data', async () => {
    const response = await controller.login(storeSlug, loginDto);

    expect(authenticateOwner).toHaveBeenCalledTimes(1);
    expect(authenticateOwner).toHaveBeenCalledWith(
      storeSlug,
      loginDto.email,
      loginDto.password,
    );
    expect(createOwnerAuthenticationState).toHaveBeenCalledTimes(1);
    expect(createOwnerAuthenticationState).toHaveBeenCalledWith(
      storeSlug,
      owner,
    );
    expect(response).toEqual({
      success: true,
      message: 'Store owner login successful',
      data: {
        accessToken: authenticationState.accessToken,
        accessTokenExpiresAt: '2026-08-15T12:15:00.000Z',
        refreshToken: authenticationState.refreshToken,
        refreshTokenExpiresAt: '2026-09-14T12:00:00.000Z',
      },
    } satisfies StoreOwnerLoginHttpResponse);
    expect(Object.keys(response.data).sort()).toEqual([
      'accessToken',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
    ]);
    expect(JSON.stringify(response)).not.toMatch(
      /ownerId|storeId|email|passwordHash|refreshTokenHash|databaseHost/i,
    );
  });

  it('passes the x-store-slug value through unchanged to both secure services', async () => {
    const suppliedHeader = 'Demo-Store ';

    await controller.login(suppliedHeader, loginDto);

    expect(authenticateOwner).toHaveBeenCalledWith(
      suppliedHeader,
      loginDto.email,
      loginDto.password,
    );
    expect(createOwnerAuthenticationState).toHaveBeenCalledWith(
      suppliedHeader,
      owner,
    );
  });

  it.each([
    ['wrong password'],
    ['unknown account'],
  ])('returns the same 401 response for %s', async () => {
    authenticateOwner.mockRejectedValue(
      unsafeDomainError(
        StoreAuthErrorCode.INVALID_STORE_CREDENTIALS,
        loginDto.password,
      ),
    );

    await expectHttpError(
      controller.login(storeSlug, loginDto),
      UnauthorizedException,
      HttpStatus.UNAUTHORIZED,
      {
        success: false,
        message: 'Store credentials are invalid.',
      },
      [loginDto.password],
    );
    expect(createOwnerAuthenticationState).not.toHaveBeenCalled();
  });

  it('returns the same 401 when the owner becomes ineligible before session creation', async () => {
    createOwnerAuthenticationState.mockRejectedValue(
      unsafeDomainError(
        StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
        owner.ownerId,
      ),
    );

    await expectHttpError(
      controller.login(storeSlug, loginDto),
      UnauthorizedException,
      HttpStatus.UNAUTHORIZED,
      { success: false, message: 'Store credentials are invalid.' },
      [owner.ownerId],
    );
  });

  it.each([undefined, '', 'Demo Store', 'demo--store'])(
    'maps missing or malformed store slug %p to a safe 400',
    async (invalidSlug) => {
      authenticateOwner.mockRejectedValue(
        unsafeDomainError(
          StoreAuthErrorCode.STORE_SLUG_INVALID,
          String(invalidSlug),
        ),
      );

      await expectHttpError(
        controller.login(invalidSlug, loginDto),
        BadRequestException,
        HttpStatus.BAD_REQUEST,
        { success: false, message: 'Store identifier is invalid.' },
        [String(invalidSlug)],
      );
      expect(createOwnerAuthenticationState).not.toHaveBeenCalled();
    },
  );

  it('does not distinguish an unknown or unavailable store from invalid credentials', async () => {
    authenticateOwner.mockRejectedValue(
      unsafeDomainError(StoreAuthErrorCode.TENANT_UNAVAILABLE, storeSlug),
    );

    await expectHttpError(
      controller.login(storeSlug, loginDto),
      UnauthorizedException,
      HttpStatus.UNAUTHORIZED,
      { success: false, message: 'Store credentials are invalid.' },
      [storeSlug],
    );
  });

  it.each([
    StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
    StoreAuthErrorCode.TENANT_IDENTITY_INVALID,
    StoreAuthErrorCode.TENANT_ACCESS_FAILED,
    StoreAuthErrorCode.TENANT_CLEANUP_FAILED,
  ])('sanitizes tenant failure %s as 503', async (code) => {
    authenticateOwner.mockRejectedValue(
      unsafeDomainError(code, 'postgresql://user:password@db.internal'),
    );

    await expectHttpError(
      controller.login(storeSlug, loginDto),
      ServiceUnavailableException,
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        success: false,
        message: 'Store login is temporarily unavailable.',
      },
      ['postgresql://', 'password', 'db.internal'],
    );
    expect(createOwnerAuthenticationState).not.toHaveBeenCalled();
  });

  it.each([
    StoreAuthErrorCode.AUTHENTICATION_CONFIGURATION_INVALID,
    StoreAuthErrorCode.ACCESS_TOKEN_ISSUANCE_FAILED,
    StoreAuthErrorCode.REFRESH_TOKEN_GENERATION_FAILED,
    StoreAuthErrorCode.REFRESH_TOKEN_HASHING_FAILED,
    StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
  ])('sanitizes session failure %s as 500', async (code) => {
    createOwnerAuthenticationState.mockRejectedValue(
      unsafeDomainError(code, authenticationState.refreshToken),
    );

    await expectHttpError(
      controller.login(storeSlug, loginDto),
      InternalServerErrorException,
      HttpStatus.INTERNAL_SERVER_ERROR,
      { success: false, message: 'Store login could not be completed.' },
      [authenticationState.refreshToken],
    );
  });

  it('sanitizes unknown failures and invalid internal timestamps', async () => {
    authenticateOwner.mockRejectedValueOnce(
      new Error(`SQL detail ${loginDto.password}`),
    );
    await expectHttpError(
      controller.login(storeSlug, loginDto),
      InternalServerErrorException,
      HttpStatus.INTERNAL_SERVER_ERROR,
      { success: false, message: 'Store login could not be completed.' },
      [loginDto.password, 'SQL detail'],
    );

    authenticateOwner.mockResolvedValueOnce(owner);
    createOwnerAuthenticationState.mockResolvedValueOnce({
      ...authenticationState,
      accessTokenExpiresAt: new Date(Number.NaN),
    });
    await expectHttpError(
      controller.login(storeSlug, loginDto),
      InternalServerErrorException,
      HttpStatus.INTERNAL_SERVER_ERROR,
      { success: false, message: 'Store login could not be completed.' },
      [authenticationState.accessToken, authenticationState.refreshToken],
    );
  });

  describe('refresh', () => {
    it('exposes POST /store/auth/refresh as HTTP 200 with no-store headers and no cookies', () => {
      const handler = StoreAuthController.prototype.refresh;
      const headers = Reflect.getMetadata(HEADERS_METADATA, handler);

      expect(Reflect.getMetadata(PATH_METADATA, StoreAuthController)).toBe(
        'store/auth',
      );
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('refresh');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.POST,
      );
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
        HttpStatus.OK,
      );
      expect(headers).toEqual([
        { name: 'Pragma', value: 'no-cache' },
        { name: 'Cache-Control', value: 'no-store' },
      ]);
      expect(headers).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Set-Cookie' }),
        ]),
      );
      expect(
        Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          StoreAuthController,
          'refresh',
        ),
      ).toEqual({
        '3:1': { index: 1, data: undefined, pipes: [] },
        '6:0': { index: 0, data: 'x-store-slug', pipes: [] },
      });
    });

    it('calls the refresh primitive exactly once and returns only the public token state', async () => {
      const response = await controller.refresh(storeSlug, refreshDto);

      expect(refreshOwnerAuthenticationState).toHaveBeenCalledTimes(1);
      expect(refreshOwnerAuthenticationState).toHaveBeenCalledWith(
        storeSlug,
        refreshDto.refreshToken,
      );
      expect(authenticateOwner).not.toHaveBeenCalled();
      expect(createOwnerAuthenticationState).not.toHaveBeenCalled();
      expect(response).toEqual({
        success: true,
        message: 'Store authentication refreshed successfully',
        data: {
          accessToken: authenticationState.accessToken,
          accessTokenExpiresAt: '2026-08-15T12:15:00.000Z',
          refreshToken: authenticationState.refreshToken,
          refreshTokenExpiresAt: '2026-09-14T12:00:00.000Z',
        },
      } satisfies StoreAuthenticationRefreshHttpResponse);
      expect(Object.keys(response.data).sort()).toEqual([
        'accessToken',
        'accessTokenExpiresAt',
        'refreshToken',
        'refreshTokenExpiresAt',
      ]);
      expect(JSON.stringify(response)).not.toMatch(
        /sessionId|ownerId|storeId|email|role|refreshTokenHash|database|signing/i,
      );
    });

    it('passes the store slug and raw refresh token through unchanged', async () => {
      const suppliedHeader = 'Demo-Store ';

      await controller.refresh(suppliedHeader, refreshDto);

      expect(refreshOwnerAuthenticationState).toHaveBeenCalledWith(
        suppliedHeader,
        authenticationState.refreshToken,
      );
    });

    it.each([
      'unknown token',
      'rotated old token',
      'expired token',
      'revoked token',
      'ineligible owner',
      'cross-tenant token',
      'malformed domain token',
    ])('returns the same safe 401 for %s', async (internalState) => {
      refreshOwnerAuthenticationState.mockRejectedValue(
        unsafeDomainError(
          StoreAuthErrorCode.AUTH_REFRESH_INVALID,
          `${internalState} ${refreshDto.refreshToken}`,
        ),
      );

      await expectHttpError(
        controller.refresh(storeSlug, refreshDto),
        UnauthorizedException,
        HttpStatus.UNAUTHORIZED,
        {
          success: false,
          message: 'Store refresh authentication is invalid or expired.',
        },
        [internalState, refreshDto.refreshToken],
      );
    });

    it('defensively maps the low-level malformed-token error to the same 401', async () => {
      refreshOwnerAuthenticationState.mockRejectedValue(
        unsafeDomainError(
          StoreAuthErrorCode.REFRESH_TOKEN_INVALID,
          refreshDto.refreshToken,
        ),
      );

      await expectHttpError(
        controller.refresh(storeSlug, refreshDto),
        UnauthorizedException,
        HttpStatus.UNAUTHORIZED,
        {
          success: false,
          message: 'Store refresh authentication is invalid or expired.',
        },
        [refreshDto.refreshToken],
      );
    });

    it.each([undefined, '', 'Demo Store', 'demo--store'])(
      'maps missing or malformed store slug %p to the existing safe 400',
      async (invalidSlug) => {
        refreshOwnerAuthenticationState.mockRejectedValue(
          unsafeDomainError(
            StoreAuthErrorCode.STORE_SLUG_INVALID,
            String(invalidSlug),
          ),
        );

        await expectHttpError(
          controller.refresh(invalidSlug, refreshDto),
          BadRequestException,
          HttpStatus.BAD_REQUEST,
          { success: false, message: 'Store identifier is invalid.' },
          [String(invalidSlug)],
        );
      },
    );

    it('does not distinguish an unavailable store from invalid refresh authentication', async () => {
      refreshOwnerAuthenticationState.mockRejectedValue(
        unsafeDomainError(StoreAuthErrorCode.TENANT_UNAVAILABLE, storeSlug),
      );

      await expectHttpError(
        controller.refresh(storeSlug, refreshDto),
        UnauthorizedException,
        HttpStatus.UNAUTHORIZED,
        {
          success: false,
          message: 'Store refresh authentication is invalid or expired.',
        },
        [storeSlug],
      );
    });

    it.each([
      StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
      StoreAuthErrorCode.TENANT_IDENTITY_INVALID,
      StoreAuthErrorCode.TENANT_ACCESS_FAILED,
      StoreAuthErrorCode.TENANT_CLEANUP_FAILED,
    ])('sanitizes tenant failure %s as 503', async (code) => {
      refreshOwnerAuthenticationState.mockRejectedValue(
        unsafeDomainError(
          code,
          'postgresql://tenant:password@db.internal/tenant_db',
        ),
      );

      await expectHttpError(
        controller.refresh(storeSlug, refreshDto),
        ServiceUnavailableException,
        HttpStatus.SERVICE_UNAVAILABLE,
        {
          success: false,
          message: 'Store authentication refresh is temporarily unavailable.',
        },
        ['postgresql://', 'password', 'db.internal', 'tenant_db'],
      );
    });

    it.each([
      StoreAuthErrorCode.AUTHENTICATION_CONFIGURATION_INVALID,
      StoreAuthErrorCode.ACCESS_TOKEN_ISSUANCE_FAILED,
      StoreAuthErrorCode.REFRESH_TOKEN_GENERATION_FAILED,
      StoreAuthErrorCode.REFRESH_TOKEN_HASHING_FAILED,
      StoreAuthErrorCode.AUTH_REFRESH_FAILED,
    ])('sanitizes internal refresh failure %s as 500', async (code) => {
      refreshOwnerAuthenticationState.mockRejectedValue(
        unsafeDomainError(code, refreshDto.refreshToken),
      );

      await expectHttpError(
        controller.refresh(storeSlug, refreshDto),
        InternalServerErrorException,
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          success: false,
          message: 'Store authentication refresh could not be completed.',
        },
        [refreshDto.refreshToken],
      );
    });

    it('sanitizes raw database failures and invalid internal timestamps', async () => {
      refreshOwnerAuthenticationState.mockRejectedValueOnce(
        new Error(`SQL hash detail ${refreshDto.refreshToken}`),
      );
      await expectHttpError(
        controller.refresh(storeSlug, refreshDto),
        InternalServerErrorException,
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          success: false,
          message: 'Store authentication refresh could not be completed.',
        },
        [refreshDto.refreshToken, 'SQL hash detail'],
      );

      refreshOwnerAuthenticationState.mockResolvedValueOnce({
        ...authenticationState,
        refreshTokenExpiresAt: new Date(Number.NaN),
      });
      await expectHttpError(
        controller.refresh(storeSlug, refreshDto),
        InternalServerErrorException,
        HttpStatus.INTERNAL_SERVER_ERROR,
        {
          success: false,
          message: 'Store authentication refresh could not be completed.',
        },
        [authenticationState.accessToken, authenticationState.refreshToken],
      );
    });

    it('does not call the refresh service when global DTO validation rejects the request', async () => {
      const validationPipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      });

      await expect(
        validationPipe.transform(
          { refreshToken: '', sessionId: 'client-controlled' },
          { type: 'body', metatype: StoreAuthenticationRefreshDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(refreshOwnerAuthenticationState).not.toHaveBeenCalled();
    });
  });
});

function unsafeDomainError(
  code: StoreAuthErrorCode,
  unsafeDetail: string,
): StoreAuthError {
  return new StoreAuthError(code, `unsafe internal detail ${unsafeDetail}`);
}

async function expectHttpError(
  promise: Promise<unknown>,
  exceptionType: new (...args: never[]) => Error,
  status: HttpStatus,
  response: object,
  forbiddenValues: string[] = [],
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected Store login HTTP request to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(exceptionType);
    expect((error as UnauthorizedException).getStatus()).toBe(status);
    expect((error as UnauthorizedException).getResponse()).toEqual(response);
    const serialized = JSON.stringify(
      (error as UnauthorizedException).getResponse(),
    );
    for (const forbiddenValue of forbiddenValues) {
      if (forbiddenValue.length > 0) {
        expect(serialized).not.toContain(forbiddenValue);
      }
    }
  }
}
