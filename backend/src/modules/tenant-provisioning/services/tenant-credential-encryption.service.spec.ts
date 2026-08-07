import { randomUUID } from 'node:crypto';

import {
  TenantCredentialEncryptionContext,
  TenantCredentialEncryptionService,
} from './tenant-credential-encryption.service';

describe('TenantCredentialEncryptionService', () => {
  let service: TenantCredentialEncryptionService;
  let encryptionKey: Buffer;
  let context: TenantCredentialEncryptionContext;

  beforeEach(() => {
    service = new TenantCredentialEncryptionService();
    encryptionKey = Buffer.alloc(32, 7);
    context = {
      tenantDatabaseRecordId: 'd10bc0ad-2c2e-4f5f-99ca-3bc0471985dd',
      storeId: '12345678-1234-4234-8123-456789012345',
      databaseName: 'tenant_db_12345678123442348123456789012345',
      databaseUser: 'tenant_user_12345678123442348123456789012345',
      keyVersion: 1,
    };
  });

  it('generates unique 32-byte base64url passwords', () => {
    const first = service.generatePassword();
    const second = service.generatePassword();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    expect(second).not.toBe(first);
  });

  it('encrypts and decrypts a password with the required envelope', () => {
    const plaintext = 'tenant-password-with-specials:@/?#';
    const payload = service.encryptPassword(plaintext, context, encryptionKey);

    expect(payload).toMatch(
      /^v1:k1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/,
    );
    expect(
      service.decryptPassword(payload, 1, context, encryptionKey),
    ).toBe(plaintext);
  });

  it('uses a different IV and ciphertext for repeated encryption', () => {
    const first = service.encryptPassword('same-password', context, encryptionKey);
    const second = service.encryptPassword('same-password', context, encryptionKey);
    const firstParts = first.split(':');
    const secondParts = second.split(':');

    expect(firstParts[2]).not.toBe(secondParts[2]);
    expect(firstParts[4]).not.toBe(secondParts[4]);
  });

  it.each([
    'not-an-envelope',
    'v1:k1:too:few',
    'v1:k1:one:two:three:four',
    'v1:k1:***:valid:valid',
  ])('rejects a malformed envelope', (payload) => {
    expect(() =>
      service.decryptPassword(payload, 1, context, encryptionKey),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it('rejects the wrong envelope version', () => {
    const payload = service
      .encryptPassword('password', context, encryptionKey)
      .replace(/^v1:/, 'v2:');

    expect(() =>
      service.decryptPassword(payload, 1, context, encryptionKey),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it('rejects the wrong key version', () => {
    const payload = service.encryptPassword('password', context, encryptionKey);

    expect(() =>
      service.decryptPassword(payload, 2, { ...context, keyVersion: 2 }, encryptionKey),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it.each([Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)])(
    'rejects an encryption key that is not exactly 32 bytes',
    (invalidKey) => {
      expect(() =>
        service.encryptPassword('password', context, invalidKey),
      ).toThrow('Tenant credential encryption key is invalid.');
    },
  );

  it('rejects malformed base64url fields', () => {
    const parts = service
      .encryptPassword('password', context, encryptionKey)
      .split(':');
    parts[2] = `${parts[2]}=`;

    expect(() =>
      service.decryptPassword(parts.join(':'), 1, context, encryptionKey),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it.each([
    ['IV', 2],
    ['authentication tag', 3],
    ['ciphertext', 4],
  ] as const)('rejects padding in the %s field', (_field, fieldIndex) => {
    const parts = service
      .encryptPassword('password', context, encryptionKey)
      .split(':');
    parts[fieldIndex] = `${parts[fieldIndex]}=`;

    expect(() =>
      service.decryptPassword(parts.join(':'), 1, context, encryptionKey),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it.each([
    ['IV', 2, Buffer.alloc(11)],
    ['authentication tag', 3, Buffer.alloc(15)],
  ] as const)('rejects a wrongly sized %s', (_field, fieldIndex, value) => {
    const parts = service
      .encryptPassword('password', context, encryptionKey)
      .split(':');
    parts[fieldIndex] = value.toString('base64url');

    expect(() =>
      service.decryptPassword(parts.join(':'), 1, context, encryptionKey),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it('rejects an empty ciphertext', () => {
    const parts = service
      .encryptPassword('password', context, encryptionKey)
      .split(':');
    parts[4] = '';

    expect(() =>
      service.decryptPassword(parts.join(':'), 1, context, encryptionKey),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it.each([
    ['authentication tag', 3],
    ['ciphertext', 4],
  ] as const)(
    'rejects a non-canonical base64url encoding in the %s field',
    (_field, fieldIndex) => {
      const parts = service
        .encryptPassword('password', context, encryptionKey)
        .split(':');
      parts[fieldIndex] = createNonCanonicalBase64Url(parts[fieldIndex]);

      expect(() =>
        service.decryptPassword(parts.join(':'), 1, context, encryptionKey),
      ).toThrow('Tenant credential could not be decrypted.');
    },
  );

  it('rejects duplicate envelope separators', () => {
    const payload = service
      .encryptPassword('password', context, encryptionKey)
      .replace(':', '::');

    expect(() =>
      service.decryptPassword(payload, 1, context, encryptionKey),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it('rejects a wrong key', () => {
    const payload = service.encryptPassword('password', context, encryptionKey);

    expect(() =>
      service.decryptPassword(payload, 1, context, Buffer.alloc(32, 8)),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it('rejects a modified authentication tag', () => {
    const parts = service
      .encryptPassword('password', context, encryptionKey)
      .split(':');
    parts[3] = alterBase64Url(parts[3]);

    expect(() =>
      service.decryptPassword(parts.join(':'), 1, context, encryptionKey),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it('rejects a modified ciphertext', () => {
    const parts = service
      .encryptPassword('password', context, encryptionKey)
      .split(':');
    parts[4] = alterBase64Url(parts[4]);

    expect(() =>
      service.decryptPassword(parts.join(':'), 1, context, encryptionKey),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it.each([
    ['storeId', '87654321-4321-4321-8123-456789012345'],
    ['tenantDatabaseRecordId', randomUUID()],
    ['databaseName', 'tenant_db_different'],
    ['databaseUser', 'tenant_user_different'],
  ] as const)('rejects modified AAD context field %s', (field, value) => {
    const payload = service.encryptPassword('password', context, encryptionKey);

    expect(() =>
      service.decryptPassword(
        payload,
        1,
        { ...context, [field]: value },
        encryptionKey,
      ),
    ).toThrow('Tenant credential could not be decrypted.');
  });

  it('uses safe error messages without secret values', () => {
    const plaintext = 'plaintext-must-not-appear';
    const payload = service.encryptPassword(plaintext, context, encryptionKey);
    const keyValue = encryptionKey.toString('base64url');
    const url =
      'postgresql://provisioner:url-password@database.example.test/postgres';
    const aad = [
      'tenant-database-password',
      context.tenantDatabaseRecordId,
      context.storeId,
      context.databaseName,
      context.databaseUser,
    ].join('|');

    try {
      service.decryptPassword(payload, 1, context, Buffer.alloc(32, 9));
      throw new Error('Expected decryption to fail');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).not.toContain(plaintext);
      expect(message).not.toContain(payload);
      expect(message).not.toContain(keyValue);
      expect(message).not.toContain(context.storeId);
      expect(message).not.toContain(context.tenantDatabaseRecordId);
      expect(message).not.toContain(url);
      expect(message).not.toContain(aad);
    }
  });
});

function alterBase64Url(value: string): string {
  return `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
}

function createNonCanonicalBase64Url(value: string): string {
  const decoded = Buffer.from(value, 'base64url');
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  for (const character of alphabet) {
    const candidate = `${value.slice(0, -1)}${character}`;

    if (
      candidate !== value &&
      Buffer.from(candidate, 'base64url').equals(decoded)
    ) {
      return candidate;
    }
  }

  throw new Error('Unable to create a non-canonical base64url value');
}
