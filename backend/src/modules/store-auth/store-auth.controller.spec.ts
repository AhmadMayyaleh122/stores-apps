import {
  BadRequestException,
  HttpStatus,
  InternalServerErrorException,
  RequestMethod,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PARAMTYPES_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

import { StoreOwnerLoginDto } from './dto/store-owner-login.dto';
import { StoreAuthenticationSessionService } from './services/store-authentication-session.service';
import { StoreOwnerLoginService } from './services/store-owner-login.service';
import {
  StoreAuthController,
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
  let authenticateOwner: jest.Mock;
  let createOwnerAuthenticationState: jest.Mock;
  let controller: StoreAuthController;

  beforeEach(() => {
    authenticateOwner = jest.fn().mockResolvedValue(owner);
    createOwnerAuthenticationState = jest
      .fn()
      .mockResolvedValue(authenticationState);
    controller = new StoreAuthController(
      { authenticateOwner } as unknown as StoreOwnerLoginService,
      {
        createOwnerAuthenticationState,
      } as unknown as StoreAuthenticationSessionService,
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

  it('depends only on the existing login and session orchestration services', () => {
    expect(Reflect.getMetadata(PARAMTYPES_METADATA, StoreAuthController)).toEqual([
      StoreOwnerLoginService,
      StoreAuthenticationSessionService,
    ]);
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
