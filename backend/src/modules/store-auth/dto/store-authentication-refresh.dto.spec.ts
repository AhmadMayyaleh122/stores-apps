import { BadRequestException, ValidationPipe } from '@nestjs/common';

import {
  STORE_AUTH_REFRESH_TOKEN_HTTP_MAX_LENGTH,
  StoreAuthenticationRefreshDto,
} from './store-authentication-refresh.dto';

describe('StoreAuthenticationRefreshDto', () => {
  const refreshToken = `srt_${Buffer.alloc(32, 7).toString('base64url')}`;
  let validationPipe: ValidationPipe;

  beforeEach(() => {
    validationPipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
  });

  it('accepts exactly one raw refresh-token string without parsing or canonicalizing it', async () => {
    const result = await validateBody({ refreshToken });

    expect(result).toBeInstanceOf(StoreAuthenticationRefreshDto);
    expect(result).toEqual({ refreshToken });
    expect(Object.keys(result)).toEqual(['refreshToken']);
  });

  it('leaves domain-level token format validation to the refresh service', async () => {
    await expect(
      validateBody({ refreshToken: 'structurally-invalid-but-nonempty' }),
    ).resolves.toMatchObject({
      refreshToken: 'structurally-invalid-but-nonempty',
    });
  });

  it.each([
    ['missing refreshToken', {}],
    ['null refreshToken', { refreshToken: null }],
    ['non-string refreshToken', { refreshToken: 42 }],
    ['object refreshToken', { refreshToken: { token: refreshToken } }],
    ['empty refreshToken', { refreshToken: '' }],
    [
      'oversized refreshToken',
      {
        refreshToken: 'x'.repeat(
          STORE_AUTH_REFRESH_TOKEN_HTTP_MAX_LENGTH + 1,
        ),
      },
    ],
    [
      'unknown field',
      { refreshToken, sessionId: 'client-controlled-session' },
    ],
  ])('rejects %s as a malformed request', async (_label, body) => {
    try {
      await validateBody(body);
      throw new Error('Expected refresh DTO validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((error as BadRequestException).getResponse())).not.toContain(
        refreshToken,
      );
    }
  });

  async function validateBody(
    body: object,
  ): Promise<StoreAuthenticationRefreshDto> {
    return validationPipe.transform(body, {
      type: 'body',
      metatype: StoreAuthenticationRefreshDto,
    }) as Promise<StoreAuthenticationRefreshDto>;
  }
});
