import { ConfigService } from '@nestjs/config';

import { StoreAuthError, StoreAuthErrorCode } from '../store-auth.errors';
import {
  DEFAULT_STORE_AUTH_ACCESS_TOKEN_AUDIENCE,
  DEFAULT_STORE_AUTH_ACCESS_TOKEN_ISSUER,
  DEFAULT_STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES,
  StoreAuthSessionConfigService,
} from './store-auth-session-config.service';

describe('StoreAuthSessionConfigService', () => {
  const signingSecret = Buffer.alloc(32, 7).toString('base64url');

  it('returns a frozen bounded configuration without exposing key material', () => {
    const configuration = createService({
      STORE_AUTH_ACCESS_TOKEN_SECRET: signingSecret,
    }).getAuthenticationConfiguration();

    expect(configuration).toMatchObject({
      accessTokenAlgorithm: 'HS256',
      accessTokenTtlSeconds:
        DEFAULT_STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlMinutes:
        DEFAULT_STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES,
      accessTokenIssuer: DEFAULT_STORE_AUTH_ACCESS_TOKEN_ISSUER,
      accessTokenAudience: DEFAULT_STORE_AUTH_ACCESS_TOKEN_AUDIENCE,
    });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.signingKey)).toBe(true);
    expect(JSON.stringify(configuration)).not.toContain(signingSecret);

    const first = configuration.signingKey.copyKeyMaterial();
    const second = configuration.signingKey.copyKeyMaterial();
    first.fill(0);
    expect(second).toEqual(Buffer.alloc(32, 7));
    second.fill(0);
  });

  it('accepts explicit valid bounds and claim context', () => {
    const configuration = createService({
      STORE_AUTH_ACCESS_TOKEN_SECRET: Buffer.alloc(64, 9).toString(
        'base64url',
      ),
      STORE_AUTH_ACCESS_TOKEN_ALGORITHM: 'HS256',
      STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS: '60',
      STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES: '525600',
      STORE_AUTH_ACCESS_TOKEN_ISSUER: ' store-auth-v1 ',
      STORE_AUTH_ACCESS_TOKEN_AUDIENCE: ' store-mobile-v1 ',
    }).getAuthenticationConfiguration();

    expect(configuration).toMatchObject({
      accessTokenAlgorithm: 'HS256',
      accessTokenTtlSeconds: 60,
      refreshTokenTtlMinutes: 525_600,
      accessTokenIssuer: 'store-auth-v1',
      accessTokenAudience: 'store-mobile-v1',
    });
  });

  it.each([
    ['missing secret', {}],
    ['weak secret', { STORE_AUTH_ACCESS_TOKEN_SECRET: Buffer.alloc(31).toString('base64url') }],
    ['invalid base64url secret', { STORE_AUTH_ACCESS_TOKEN_SECRET: 'not+base64/url=' }],
    ['noncanonical secret', { STORE_AUTH_ACCESS_TOKEN_SECRET: `${signingSecret}=` }],
    ['unsupported algorithm', { STORE_AUTH_ACCESS_TOKEN_SECRET: signingSecret, STORE_AUTH_ACCESS_TOKEN_ALGORITHM: 'HS384' }],
    ['access TTL below bound', { STORE_AUTH_ACCESS_TOKEN_SECRET: signingSecret, STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS: '59' }],
    ['access TTL above bound', { STORE_AUTH_ACCESS_TOKEN_SECRET: signingSecret, STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS: '3601' }],
    ['malformed access TTL', { STORE_AUTH_ACCESS_TOKEN_SECRET: signingSecret, STORE_AUTH_ACCESS_TOKEN_TTL_SECONDS: '60.5' }],
    ['refresh TTL below bound', { STORE_AUTH_ACCESS_TOKEN_SECRET: signingSecret, STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES: '59' }],
    ['refresh TTL above bound', { STORE_AUTH_ACCESS_TOKEN_SECRET: signingSecret, STORE_AUTH_REFRESH_TOKEN_TTL_MINUTES: '525601' }],
    ['empty issuer', { STORE_AUTH_ACCESS_TOKEN_SECRET: signingSecret, STORE_AUTH_ACCESS_TOKEN_ISSUER: '  ' }],
    ['control character audience', { STORE_AUTH_ACCESS_TOKEN_SECRET: signingSecret, STORE_AUTH_ACCESS_TOKEN_AUDIENCE: 'mobile\nclient' }],
  ])('fails safely for %s', (_label, values) => {
    expectCode(
      () => createService(values).getAuthenticationConfiguration(),
      StoreAuthErrorCode.AUTHENTICATION_CONFIGURATION_INVALID,
    );
  });

  function createService(
    values: Record<string, unknown>,
  ): StoreAuthSessionConfigService {
    return new StoreAuthSessionConfigService(
      new ConfigService(values),
    );
  }
});

function expectCode(operation: () => unknown, code: StoreAuthErrorCode): void {
  try {
    operation();
    throw new Error('Expected authentication configuration to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
  }
}
