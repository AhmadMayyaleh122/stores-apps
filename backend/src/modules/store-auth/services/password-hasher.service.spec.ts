import * as argon2 from 'argon2';

import { StoreAuthErrorCode } from '../store-auth.errors';
import {
  PasswordHasherService,
  STORE_PASSWORD_ARGON2_OPTIONS,
} from './password-hasher.service';
import { PasswordPolicyService } from './password-policy.service';

describe('PasswordHasherService', () => {
  const password = 'correct horse battery staple';
  let service: PasswordHasherService;

  beforeEach(() => {
    service = new PasswordHasherService(new PasswordPolicyService());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('produces an encoded Argon2id hash with explicitly controlled parameters', async () => {
    const hash = await service.hash(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(STORE_PASSWORD_ARGON2_OPTIONS).toEqual({
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
    });
    expect(Object.isFrozen(STORE_PASSWORD_ARGON2_OPTIONS)).toBe(true);
  });

  it('verifies the correct password and rejects an incorrect password', async () => {
    const hash = await service.hash(password);

    await expect(service.verify(hash, password)).resolves.toBe(true);
    await expect(service.verify(hash, `${password}!`)).resolves.toBe(false);
  });

  it('returns false for a malformed stored hash', async () => {
    await expect(service.verify('not-an-argon2-hash', password)).resolves.toBe(
      false,
    );
  });

  it('uses independent library-generated salts for the same password', async () => {
    const [firstHash, secondHash] = await Promise.all([
      service.hash(password),
      service.hash(password),
    ]);

    expect(firstHash).not.toBe(secondHash);
    await expect(service.verify(firstHash, password)).resolves.toBe(true);
    await expect(service.verify(secondHash, password)).resolves.toBe(true);
  });

  it('normalizes with NFC before hashing and verification', async () => {
    const decomposedPassword = 'e\u0301'.repeat(15);
    const normalizedPassword = 'é'.repeat(15);
    const hash = await service.hash(decomposedPassword);

    await expect(service.verify(hash, normalizedPassword)).resolves.toBe(true);
  });

  it('translates hashing failures without exposing plaintext or Argon2 details', async () => {
    const rawFailure = `argon2 native detail for ${password}`;
    jest.spyOn(argon2, 'hash').mockRejectedValueOnce(new Error(rawFailure));

    try {
      await service.hash(password);
      throw new Error('Expected password hashing to fail');
    } catch (error) {
      expect(error).toEqual(
        expect.objectContaining({
          code: StoreAuthErrorCode.PASSWORD_HASHING_FAILED,
          message: 'Password could not be secured.',
        }),
      );
      expect(JSON.stringify(error)).not.toContain(password);
      expect(JSON.stringify(error)).not.toContain(rawFailure);
    }
  });

  it('returns false for unexpected verification failures', async () => {
    jest
      .spyOn(argon2, 'verify')
      .mockRejectedValueOnce(new Error('raw Argon2 verification detail'));

    await expect(service.verify('opaque-hash', password)).resolves.toBe(false);
  });

  it('returns false when the supplied password violates policy', async () => {
    const hash = await service.hash(password);

    await expect(service.verify(hash, 'too-short')).resolves.toBe(false);
  });
});
