import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { StoreAuthError, StoreAuthErrorCode } from '../store-auth.errors';
import { StoreAccessTokenService } from './store-access-token.service';
import { StoreAuthSessionConfigService } from './store-auth-session-config.service';

describe('StoreAccessTokenService', () => {
  const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const storeId = '12345678-1234-4234-8123-456789012345';
  const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const signingSecret = Buffer.alloc(32, 6).toString('base64url');
  const signingKey = Buffer.from(signingSecret, 'base64url');
  const issuer = 'store-auth-test';
  const audience = 'store-mobile-test';
  const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  let jwtService: JwtService;
  let service: StoreAccessTokenService;

  beforeEach(() => {
    jwtService = new JwtService();
    service = createService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('issues and verifies an HS256 token bound to owner, store, and session', async () => {
    const issued = await service.issue({ ownerId, storeId, sessionId, issuedAt: now });
    const decoded = jwtService.decode<Record<string, unknown>>(issued.accessToken);
    const header = JSON.parse(
      Buffer.from(issued.accessToken.split('.')[0], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(decoded).toEqual({
      sub: ownerId,
      storeId,
      sid: sessionId,
      iat: now.getTime() / 1_000,
      exp: now.getTime() / 1_000 + 900,
      iss: issuer,
      aud: audience,
    });
    expect(Object.keys(decoded as object).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'sid',
      'storeId',
      'sub',
    ]);
    expect(JSON.stringify(decoded)).not.toMatch(/email|password|role|database/i);
    expect(issued.expiresAt).toEqual(new Date(now.getTime() + 900_000));
    await expect(service.verify(issued.accessToken)).resolves.toEqual(decoded);
  });

  it('derives iat and exp from the supplied database timestamp, not application time', async () => {
    const databaseTime = new Date(now.getTime() - 120_000);
    const issued = await service.issue({ ownerId, storeId, sessionId, issuedAt: databaseTime });
    const decoded = jwtService.decode<Record<string, number>>(issued.accessToken);

    expect(decoded.iat).toBe(databaseTime.getTime() / 1_000);
    expect(decoded.exp).toBe(databaseTime.getTime() / 1_000 + 900);
    expect(issued.expiresAt).toEqual(
      new Date(databaseTime.getTime() + 900_000),
    );
  });

  it('rejects tampered, malformed, and expired tokens with one safe error', async () => {
    const issued = await service.issue({ ownerId, storeId, sessionId, issuedAt: now });
    const tampered = `${issued.accessToken.slice(0, -1)}${issued.accessToken.endsWith('a') ? 'b' : 'a'}`;

    await expectCode(service.verify(tampered), StoreAuthErrorCode.ACCESS_TOKEN_INVALID);
    await expectCode(service.verify('not-a-jwt'), StoreAuthErrorCode.ACCESS_TOKEN_INVALID);
    const expired = await service.issue({
      ownerId,
      storeId,
      sessionId,
      issuedAt: new Date(now.getTime() - 3_600_000),
    });
    await expectCode(service.verify(expired.accessToken), StoreAuthErrorCode.ACCESS_TOKEN_INVALID);
  });

  it.each([
    ['wrong issuer', { issuer: 'another-issuer', audience }],
    ['wrong audience', { issuer, audience: 'another-audience' }],
  ])('rejects a correctly signed token with %s', async (_label, context) => {
    const token = await jwtService.signAsync(
      { sub: ownerId, storeId, sid: sessionId, iat: now.getTime() / 1_000 },
      { secret: signingKey, algorithm: 'HS256', issuer: context.issuer, audience: context.audience, expiresIn: 900 },
    );

    await expectCode(service.verify(token), StoreAuthErrorCode.ACCESS_TOKEN_INVALID);
  });

  it('pins HS256 and rejects a token signed with another HMAC algorithm', async () => {
    const token = await jwtService.signAsync(
      { sub: ownerId, storeId, sid: sessionId, iat: now.getTime() / 1_000 },
      { secret: signingKey, algorithm: 'HS384', issuer, audience, expiresIn: 900 },
    );

    await expectCode(service.verify(token), StoreAuthErrorCode.ACCESS_TOKEN_INVALID);
  });

  it('rejects extra claims even when a token is otherwise correctly signed', async () => {
    const token = await jwtService.signAsync(
      { sub: ownerId, storeId, sid: sessionId, iat: now.getTime() / 1_000, role: 'OWNER' },
      { secret: signingKey, algorithm: 'HS256', issuer, audience, expiresIn: 900 },
    );

    await expectCode(service.verify(token), StoreAuthErrorCode.ACCESS_TOKEN_INVALID);
  });

  it('fails issuance safely for invalid identity, precision, and signer output', async () => {
    await expectCode(
      service.issue({ ownerId: 'not-a-uuid', storeId, sessionId, issuedAt: now }),
      StoreAuthErrorCode.ACCESS_TOKEN_ISSUANCE_FAILED,
    );
    await expectCode(
      service.issue({ ownerId, storeId, sessionId, issuedAt: new Date(now.getTime() + 1) }),
      StoreAuthErrorCode.ACCESS_TOKEN_ISSUANCE_FAILED,
    );
    jest.spyOn(jwtService, 'signAsync').mockResolvedValue('unsafe signing detail' as never);
    await expectCode(
      service.issue({ ownerId, storeId, sessionId, issuedAt: now }),
      StoreAuthErrorCode.ACCESS_TOKEN_ISSUANCE_FAILED,
      'unsafe signing detail',
    );
  });

  it('preserves the dedicated safe configuration failure', async () => {
    const invalidService = new StoreAccessTokenService(
      jwtService,
      new StoreAuthSessionConfigService(new ConfigService({})),
    );

    await expectCode(
      invalidService.issue({ ownerId, storeId, sessionId, issuedAt: now }),
      StoreAuthErrorCode.AUTHENTICATION_CONFIGURATION_INVALID,
      signingSecret,
    );
  });

  function createService(): StoreAccessTokenService {
    return new StoreAccessTokenService(
      jwtService,
      new StoreAuthSessionConfigService(
        new ConfigService({
          STORE_AUTH_ACCESS_TOKEN_SECRET: signingSecret,
          STORE_AUTH_ACCESS_TOKEN_ISSUER: issuer,
          STORE_AUTH_ACCESS_TOKEN_AUDIENCE: audience,
        }),
      ),
    );
  }
});

async function expectCode(
  promise: Promise<unknown>,
  code: StoreAuthErrorCode,
  forbiddenValue?: string,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected access token operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
    if (forbiddenValue) expect((error as Error).message).not.toContain(forbiddenValue);
  }
}
