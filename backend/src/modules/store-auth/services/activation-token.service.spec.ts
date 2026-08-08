import * as crypto from 'node:crypto';

import { StoreAuthErrorCode } from '../store-auth.errors';
import {
  ActivationTokenService,
  STORE_OWNER_ACTIVATION_TOKEN_BYTES,
  STORE_OWNER_ACTIVATION_TOKEN_PREFIX,
} from './activation-token.service';

describe('ActivationTokenService', () => {
  let service: ActivationTokenService;

  beforeEach(() => {
    service = new ActivationTokenService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates a strict soa_ token containing exactly 32 random bytes', () => {
    const generated = service.generate();
    const encodedPayload = generated.rawToken.slice(
      STORE_OWNER_ACTIVATION_TOKEN_PREFIX.length,
    );

    expect(generated.rawToken).toMatch(/^soa_[A-Za-z0-9_-]{43}$/);
    expect(encodedPayload).not.toContain('=');
    expect(Buffer.from(encodedPayload, 'base64url')).toHaveLength(
      STORE_OWNER_ACTIVATION_TOKEN_BYTES,
    );
    expect(service.parse(generated.rawToken)).toBe(generated.rawToken);
  });

  it('returns the 32-byte SHA-256 digest of the canonical raw token', () => {
    const generated = service.generate();
    const expectedHash = crypto
      .createHash('sha256')
      .update(generated.rawToken, 'ascii')
      .digest();

    expect(Buffer.isBuffer(generated.tokenHash)).toBe(true);
    expect(generated.tokenHash).toHaveLength(32);
    expect(generated.tokenHash).toEqual(expectedHash);
    expect(generated.tokenHash.toString('utf8')).not.toContain(
      generated.rawToken,
    );
  });

  it('hashes the same canonical token deterministically', () => {
    const { rawToken } = service.generate();

    expect(service.hash(rawToken)).toEqual(service.hash(rawToken));
  });

  it('generates different tokens and digests', () => {
    const first = service.generate();
    const second = service.generate();

    expect(first.rawToken).not.toBe(second.rawToken);
    expect(first.tokenHash).not.toEqual(second.tokenHash);
  });

  it.each([
    ['wrong prefix', `bad_${Buffer.alloc(32).toString('base64url')}`],
    ['invalid base64url', `soa_${'A'.repeat(42)}+`],
    ['wrong decoded length', `soa_${Buffer.alloc(31).toString('base64url')}`],
    ['padded value', `soa_${Buffer.alloc(32).toString('base64url')}=`],
    ['noncanonical trailing bits', `soa_${'A'.repeat(42)}B`],
  ])('rejects a %s safely', (_caseName, rawToken) => {
    expect(() => service.parse(rawToken)).toThrow(
      expect.objectContaining({
        code: StoreAuthErrorCode.ACTIVATION_TOKEN_INVALID,
      }),
    );
  });

  it('never includes a rejected raw token in its error', () => {
    const rawToken = 'soa_do-not-expose-this-invalid-token';

    try {
      service.parse(rawToken);
      throw new Error('Expected activation token parsing to fail');
    } catch (error) {
      expect((error as Error).message).toBe('Activation token is invalid.');
      expect(JSON.stringify(error)).not.toContain(rawToken);
    }
  });

  it('rejects a non-string runtime token safely', () => {
    expect(() => service.parse(null as unknown as string)).toThrow(
      expect.objectContaining({
        code: StoreAuthErrorCode.ACTIVATION_TOKEN_INVALID,
      }),
    );
  });

  it('translates token hashing failures without exposing crypto details', () => {
    const { rawToken } = service.generate();
    const rawFailure = `crypto hashing detail for ${rawToken}`;
    jest.spyOn(crypto, 'createHash').mockImplementationOnce(() => {
      throw new Error(rawFailure);
    });

    try {
      service.hash(rawToken);
      throw new Error('Expected activation token hashing to fail');
    } catch (error) {
      expect(error).toEqual(
        expect.objectContaining({
          code: StoreAuthErrorCode.ACTIVATION_TOKEN_HASHING_FAILED,
          message: 'Activation token could not be secured.',
        }),
      );
      expect(JSON.stringify(error)).not.toContain(rawToken);
      expect(JSON.stringify(error)).not.toContain(rawFailure);
    }
  });

  it('translates cryptographic generation failures to a stable safe error', () => {
    const rawFailure = 'operating system random source detail';
    jest.spyOn(crypto, 'randomBytes').mockImplementationOnce(() => {
      throw new Error(rawFailure);
    });

    try {
      service.generate();
      throw new Error('Expected activation token generation to fail');
    } catch (error) {
      expect(error).toEqual(
        expect.objectContaining({
          code: StoreAuthErrorCode.ACTIVATION_TOKEN_GENERATION_FAILED,
          message: 'Activation token could not be generated.',
        }),
      );
      expect(JSON.stringify(error)).not.toContain(rawFailure);
    }
  });

  it('rejects an unexpected random byte length as a generation failure', () => {
    jest
      .spyOn(crypto, 'randomBytes')
      .mockReturnValueOnce(
        Buffer.alloc(STORE_OWNER_ACTIVATION_TOKEN_BYTES - 1) as never,
      );

    expect(() => service.generate()).toThrow(
      expect.objectContaining({
        code: StoreAuthErrorCode.ACTIVATION_TOKEN_GENERATION_FAILED,
      }),
    );
  });
});
