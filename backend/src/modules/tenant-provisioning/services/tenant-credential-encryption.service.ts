import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

import {
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning.errors';
import {
  normalizeCanonicalUuid,
  validatePostgresIdentifier,
} from '../utils/tenant-database-identifier.util';

const ENVELOPE_VERSION = 'v1';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_BYTES = 32;
const INITIALIZATION_VECTOR_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface TenantCredentialEncryptionContext {
  tenantDatabaseRecordId: string;
  storeId: string;
  databaseName: string;
  databaseUser: string;
  keyVersion: number;
}

interface ValidatedEncryptionContext {
  tenantDatabaseRecordId: string;
  storeId: string;
  databaseName: string;
  databaseUser: string;
  keyVersion: number;
}

@Injectable()
export class TenantCredentialEncryptionService {
  generatePassword(): string {
    return randomBytes(32).toString('base64url');
  }

  encryptPassword(
    plaintext: string,
    context: TenantCredentialEncryptionContext,
    encryptionKey: Buffer,
  ): string {
    const key = copyAndValidateEncryptionKey(encryptionKey);
    let plaintextBuffer: Buffer | undefined;

    try {
      if (typeof plaintext !== 'string' || plaintext.length === 0) {
        throw createEncryptionFailure();
      }

      const validatedContext = validateContext(context);
      const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES);
      const cipher = createCipheriv(
        ENCRYPTION_ALGORITHM,
        key,
        initializationVector,
        { authTagLength: AUTHENTICATION_TAG_BYTES },
      );
      cipher.setAAD(buildAdditionalAuthenticatedData(validatedContext));
      plaintextBuffer = Buffer.from(plaintext, 'utf8');
      const ciphertext = Buffer.concat([
        cipher.update(plaintextBuffer),
        cipher.final(),
      ]);
      const authenticationTag = cipher.getAuthTag();

      return [
        ENVELOPE_VERSION,
        `k${validatedContext.keyVersion}`,
        initializationVector.toString('base64url'),
        authenticationTag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join(':');
    } catch (error) {
      if (error instanceof TenantProvisioningError) {
        throw error;
      }

      throw createEncryptionFailure();
    } finally {
      key.fill(0);
      plaintextBuffer?.fill(0);
    }
  }

  decryptPassword(
    payload: string,
    expectedKeyVersion: number,
    context: TenantCredentialEncryptionContext,
    encryptionKey: Buffer,
  ): string {
    const key = copyAndValidateEncryptionKey(encryptionKey);
    let plaintextBuffer: Buffer | undefined;

    try {
      const validatedContext = validateContext(context);

      if (
        !Number.isInteger(expectedKeyVersion) ||
        expectedKeyVersion < 1 ||
        validatedContext.keyVersion !== expectedKeyVersion
      ) {
        throw createDecryptionFailure();
      }

      const envelope = parseEnvelope(payload);

      if (envelope.keyVersion !== expectedKeyVersion) {
        throw createDecryptionFailure();
      }

      const decipher = createDecipheriv(
        ENCRYPTION_ALGORITHM,
        key,
        envelope.initializationVector,
        { authTagLength: AUTHENTICATION_TAG_BYTES },
      );
      decipher.setAAD(buildAdditionalAuthenticatedData(validatedContext));
      decipher.setAuthTag(envelope.authenticationTag);
      plaintextBuffer = Buffer.concat([
        decipher.update(envelope.ciphertext),
        decipher.final(),
      ]);

      return plaintextBuffer.toString('utf8');
    } catch (error) {
      if (
        error instanceof TenantProvisioningError &&
        error.code === TenantProvisioningErrorCode.ENCRYPTION_KEY_INVALID
      ) {
        throw error;
      }

      throw createDecryptionFailure();
    } finally {
      key.fill(0);
      plaintextBuffer?.fill(0);
    }
  }
}

function validateContext(
  context: TenantCredentialEncryptionContext,
): ValidatedEncryptionContext {
  if (
    !context ||
    !Number.isInteger(context.keyVersion) ||
    context.keyVersion < 1
  ) {
    throw createEncryptionFailure();
  }

  return {
    tenantDatabaseRecordId: normalizeCanonicalUuid(
      context.tenantDatabaseRecordId,
    ),
    storeId: normalizeCanonicalUuid(context.storeId),
    databaseName: validatePostgresIdentifier(context.databaseName),
    databaseUser: validatePostgresIdentifier(context.databaseUser),
    keyVersion: context.keyVersion,
  };
}

function buildAdditionalAuthenticatedData(
  context: ValidatedEncryptionContext,
): Buffer {
  return Buffer.from(
    [
      'tenant-database-password',
      context.tenantDatabaseRecordId,
      context.storeId,
      context.databaseName,
      context.databaseUser,
      context.keyVersion,
    ].join('|'),
    'utf8',
  );
}

function copyAndValidateEncryptionKey(encryptionKey: Buffer): Buffer {
  if (
    !Buffer.isBuffer(encryptionKey) ||
    encryptionKey.length !== ENCRYPTION_KEY_BYTES
  ) {
    throw new TenantProvisioningError(
      TenantProvisioningErrorCode.ENCRYPTION_KEY_INVALID,
      'Tenant credential encryption key is invalid.',
    );
  }

  return Buffer.from(encryptionKey);
}

function parseEnvelope(payload: string): {
  keyVersion: number;
  initializationVector: Buffer;
  authenticationTag: Buffer;
  ciphertext: Buffer;
} {
  if (typeof payload !== 'string') {
    throw createDecryptionFailure();
  }

  const parts = payload.split(':');

  if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
    throw createDecryptionFailure();
  }

  const keyVersionMatch = /^k([1-9]\d*)$/.exec(parts[1]);

  if (!keyVersionMatch) {
    throw createDecryptionFailure();
  }

  const keyVersion = Number(keyVersionMatch[1]);
  const initializationVector = decodeStrictBase64Url(parts[2]);
  const authenticationTag = decodeStrictBase64Url(parts[3]);
  const ciphertext = decodeStrictBase64Url(parts[4]);

  if (
    !Number.isSafeInteger(keyVersion) ||
    initializationVector.length !== INITIALIZATION_VECTOR_BYTES ||
    authenticationTag.length !== AUTHENTICATION_TAG_BYTES ||
    ciphertext.length === 0
  ) {
    throw createDecryptionFailure();
  }

  return {
    keyVersion,
    initializationVector,
    authenticationTag,
    ciphertext,
  };
}

function decodeStrictBase64Url(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throw createDecryptionFailure();
  }

  const decoded = Buffer.from(value, 'base64url');

  if (decoded.toString('base64url') !== value) {
    decoded.fill(0);
    throw createDecryptionFailure();
  }

  return decoded;
}

function createEncryptionFailure(): TenantProvisioningError {
  return new TenantProvisioningError(
    TenantProvisioningErrorCode.CREDENTIAL_ENCRYPTION_FAILED,
    'Tenant credential could not be encrypted.',
  );
}

function createDecryptionFailure(): TenantProvisioningError {
  return new TenantProvisioningError(
    TenantProvisioningErrorCode.CREDENTIAL_DECRYPTION_FAILED,
    'Tenant credential could not be decrypted.',
  );
}
