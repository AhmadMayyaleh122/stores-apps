import * as crypto from 'node:crypto';

import { StoreAuthError, StoreAuthErrorCode } from '../store-auth.errors';
import {
  RefreshTokenService,
  STORE_REFRESH_TOKEN_BYTES,
  STORE_REFRESH_TOKEN_PREFIX,
} from './refresh-token.service';

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;

  beforeEach(() => {
    service = new RefreshTokenService();
    jest.restoreAllMocks();
  });

  it('generates distinct URL-safe 256-bit tokens and SHA-256 hashes', () => {
    const first = service.generate();
    const second = service.generate();

    expect(first.rawToken).toMatch(/^srt_[A-Za-z0-9_-]{43}$/);
    expect(first.rawToken.startsWith(STORE_REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(first.rawToken).not.toBe(second.rawToken);
    expect(first.tokenHash).toHaveLength(STORE_REFRESH_TOKEN_BYTES);
    expect(first.tokenHash.toString('utf8')).not.toContain(first.rawToken);
    expect(first.tokenHash).toEqual(service.hash(first.rawToken));
    expect(service.verify(first.rawToken, first.tokenHash)).toBe(true);
    expect(service.verify(second.rawToken, first.tokenHash)).toBe(false);
  });

  it.each([
    undefined,
    '',
    'srt_short',
    `bad_${'a'.repeat(43)}`,
    `srt_${'a'.repeat(42)}+`,
    `srt_${'a'.repeat(44)}`,
  ])('rejects malformed raw token %p', (rawToken) => {
    expectCode(() => service.parse(rawToken), StoreAuthErrorCode.REFRESH_TOKEN_INVALID);
    expect(service.verify(rawToken, Buffer.alloc(32))).toBe(false);
  });

  it('rejects malformed stored hashes without invoking timingSafeEqual', () => {
    const timingSafeEqual = jest.spyOn(crypto, 'timingSafeEqual');
    const token = service.generate().rawToken;

    expect(service.verify(token, Buffer.alloc(31))).toBe(false);
    expect(service.verify(token, 'hash')).toBe(false);
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it('maps random generation failures without leaking their detail', () => {
    jest.spyOn(crypto, 'randomBytes').mockImplementation(() => {
      throw new Error('entropy provider secret detail');
    });

    expectCode(
      () => service.generate(),
      StoreAuthErrorCode.REFRESH_TOKEN_GENERATION_FAILED,
      'entropy provider secret detail',
    );
  });

  it('maps digest failures to the dedicated safe hashing error', () => {
    const rawToken = `srt_${Buffer.alloc(32, 5).toString('base64url')}`;
    jest.spyOn(crypto, 'createHash').mockImplementation(() => {
      throw new Error('digest engine secret detail');
    });

    expectCode(
      () => service.hash(rawToken),
      StoreAuthErrorCode.REFRESH_TOKEN_HASHING_FAILED,
      'digest engine secret detail',
    );
    expectCode(
      () => service.generate(),
      StoreAuthErrorCode.REFRESH_TOKEN_HASHING_FAILED,
      rawToken,
    );
  });
});

function expectCode(
  operation: () => unknown,
  code: StoreAuthErrorCode,
  forbiddenValue?: string,
): void {
  try {
    operation();
    throw new Error('Expected refresh token operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StoreAuthError);
    expect((error as StoreAuthError).code).toBe(code);
    if (forbiddenValue) expect((error as Error).message).not.toContain(forbiddenValue);
  }
}
