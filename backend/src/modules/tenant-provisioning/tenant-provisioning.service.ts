import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { TenantProvisioningStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PostgresTenantProvisionerService } from './services/postgres-tenant-provisioner.service';
import { TenantCredentialEncryptionService } from './services/tenant-credential-encryption.service';
import { TenantIdentityInitializerService } from './services/tenant-identity-initializer.service';
import { TenantMigrationRunnerService } from './services/tenant-migration-runner.service';
import {
  TenantProvisioningConfiguration,
  TenantProvisioningConfigService,
} from './services/tenant-provisioning-config.service';
import {
  createTenantProvisioningError,
  getTenantProvisioningSafeMessage,
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from './tenant-provisioning.errors';
import {
  tenantProvisioningInternalSelect,
  TenantProvisioningInternalRecord,
  tenantProvisioningPublicSelect,
  TenantProvisioningPublicRecord,
} from './tenant-provisioning.select';
import { createTenantDatabaseIdentifiers } from './utils/tenant-database-identifier.util';
import { buildTenantDatabaseUrl } from './utils/tenant-database-url.util';

const CANONICAL_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CLAIMABLE_STATUSES = [
  TenantProvisioningStatus.PENDING,
  TenantProvisioningStatus.FAILED,
] as const;

export interface TenantProvisioningResult {
  provisioning: TenantProvisioningPublicRecord;
  alreadyReady: boolean;
}

@Injectable()
export class TenantProvisioningService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: TenantProvisioningConfigService,
    private readonly encryptionService: TenantCredentialEncryptionService,
    private readonly postgresProvisioner: PostgresTenantProvisionerService,
    private readonly migrationRunner: TenantMigrationRunnerService,
    private readonly identityInitializer: TenantIdentityInitializerService,
  ) {}

  async provisionStore(storeId: string): Promise<TenantProvisioningResult> {
    try {
      return await this.provisionStoreInternal(requireCanonicalUuidV4(storeId));
    } catch (error) {
      throw sanitizeError(error);
    }
  }

  async getStoreProvisioning(
    storeId: string,
  ): Promise<TenantProvisioningPublicRecord | null> {
    try {
      const normalizedStoreId = requireCanonicalUuidV4(storeId);
      await this.requireStore(normalizedStoreId);

      const record = await this.prismaService.tenantDatabase.findUnique({
        where: { storeId: normalizedStoreId },
        select: tenantProvisioningPublicSelect,
      });

      return record ? toPublicRecord(record) : null;
    } catch (error) {
      throw sanitizeError(error);
    }
  }

  async getProvisioningStatus(
    storeId: string,
  ): Promise<TenantProvisioningPublicRecord> {
    const provisioning = await this.getStoreProvisioning(storeId);

    if (!provisioning) {
      throw createSafeError(
        TenantProvisioningErrorCode.PROVISIONING_NOT_FOUND,
      );
    }

    return provisioning;
  }

  private async provisionStoreInternal(
    storeId: string,
  ): Promise<TenantProvisioningResult> {
    await this.requireStore(storeId);
    let record = await this.prismaService.tenantDatabase.findUnique({
      where: { storeId },
      select: tenantProvisioningInternalSelect,
    });

    if (record?.status === TenantProvisioningStatus.READY) {
      return {
        provisioning: toPublicRecord(record),
        alreadyReady: true,
      };
    }

    if (record?.status === TenantProvisioningStatus.PROVISIONING) {
      throw createSafeError(
        TenantProvisioningErrorCode.PROVISIONING_IN_PROGRESS,
      );
    }

    if (record && !CLAIMABLE_STATUSES.includes(record.status)) {
      throw createSafeError(
        TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
      );
    }

    const configuration = this.configService.getProvisioningConfiguration();
    const identifiers = createTenantDatabaseIdentifiers(storeId);

    record ??= await this.createOrRecoverPendingRecord(
      storeId,
      identifiers.databaseName,
      identifiers.databaseUser,
      configuration,
    );

    if (record.status === TenantProvisioningStatus.READY) {
      return {
        provisioning: toPublicRecord(record),
        alreadyReady: true,
      };
    }

    if (record.status === TenantProvisioningStatus.PROVISIONING) {
      throw createSafeError(
        TenantProvisioningErrorCode.PROVISIONING_IN_PROGRESS,
      );
    }

    if (!CLAIMABLE_STATUSES.includes(record.status)) {
      throw createSafeError(
        TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
      );
    }

    assertRecordIntegrity(record, storeId, identifiers, configuration);
    const expectedAttemptCount = record.attemptCount + 1;
    const claim = await this.prismaService.tenantDatabase.updateMany({
      where: {
        id: record.id,
        status: { in: [...CLAIMABLE_STATUSES] },
      },
      data: {
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount: { increment: 1 },
        provisioningStartedAt: new Date(),
        provisionedAt: null,
        failedAt: null,
        lastFailureCode: null,
        lastFailureMessage: null,
      },
    });

    if (claim.count !== 1) {
      return this.resolveLostClaim(record.id);
    }

    const claimedRecord = await this.prismaService.tenantDatabase.findUnique({
      where: { id: record.id },
      select: tenantProvisioningInternalSelect,
    });

    if (
      claimedRecord?.id !== record.id ||
      claimedRecord?.storeId !== record.storeId ||
      claimedRecord?.status !== TenantProvisioningStatus.PROVISIONING ||
      claimedRecord?.attemptCount !== expectedAttemptCount
    ) {
      throw createSafeError(
        TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
      );
    }

    try {
      assertRecordIntegrity(
        claimedRecord,
        storeId,
        identifiers,
        configuration,
      );

      return await this.executeClaimedAttempt(
        claimedRecord,
        configuration,
        expectedAttemptCount,
      );
    } catch (error) {
      const safeError = sanitizeError(error);
      await this.persistFailure(record.id, expectedAttemptCount, safeError);
      throw safeError;
    }
  }

  private async requireStore(storeId: string): Promise<void> {
    const store = await this.prismaService.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });

    if (!store) {
      throw createSafeError(TenantProvisioningErrorCode.STORE_NOT_FOUND);
    }
  }

  private async createOrRecoverPendingRecord(
    storeId: string,
    databaseName: string,
    databaseUser: string,
    configuration: TenantProvisioningConfiguration,
  ): Promise<TenantProvisioningInternalRecord> {
    const id = randomUUID();
    const plaintextPassword = this.encryptionService.generatePassword();
    const keyMaterial = configuration.activeEncryptionKey.copyKeyMaterial();
    let databasePasswordEncrypted: string;

    try {
      databasePasswordEncrypted = this.encryptionService.encryptPassword(
        plaintextPassword,
        {
          tenantDatabaseRecordId: id,
          storeId,
          databaseName,
          databaseUser,
          keyVersion: configuration.activeEncryptionKeyVersion,
        },
        keyMaterial,
      );
    } finally {
      keyMaterial.fill(0);
    }

    try {
      return await this.prismaService.tenantDatabase.create({
        data: {
          id,
          storeId,
          status: TenantProvisioningStatus.PENDING,
          databaseName,
          databaseHost: configuration.tenantDatabaseHost,
          databasePort: configuration.tenantDatabasePort,
          databaseUser,
          databasePasswordEncrypted,
          encryptionKeyVersion: configuration.activeEncryptionKeyVersion,
          attemptCount: 0,
        },
        select: tenantProvisioningInternalSelect,
      });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2003')) {
        const store = await this.prismaService.store.findUnique({
          where: { id: storeId },
          select: { id: true },
        });

        throw createSafeError(
          store
            ? TenantProvisioningErrorCode.PROVISIONING_FAILED
            : TenantProvisioningErrorCode.STORE_NOT_FOUND,
        );
      }

      if (!hasPrismaErrorCode(error, 'P2002')) {
        throw error;
      }

      const racedRecord =
        await this.prismaService.tenantDatabase.findUnique({
          where: { storeId },
          select: tenantProvisioningInternalSelect,
        });

      if (racedRecord) {
        return racedRecord;
      }

      const identifierOwner =
        await this.prismaService.tenantDatabase.findFirst({
          where: {
            OR: [{ databaseName }, { databaseUser }],
          },
          select: { id: true, storeId: true },
        });

      throw createSafeError(
        identifierOwner
          ? TenantProvisioningErrorCode.IDENTIFIER_CONFLICT
          : TenantProvisioningErrorCode.PROVISIONING_FAILED,
      );
    }
  }

  private async resolveLostClaim(
    recordId: string,
  ): Promise<TenantProvisioningResult> {
    const current = await this.prismaService.tenantDatabase.findUnique({
      where: { id: recordId },
      select: tenantProvisioningInternalSelect,
    });

    if (current?.status === TenantProvisioningStatus.READY) {
      return {
        provisioning: toPublicRecord(current),
        alreadyReady: true,
      };
    }

    if (current?.status === TenantProvisioningStatus.PROVISIONING) {
      throw createSafeError(
        TenantProvisioningErrorCode.PROVISIONING_IN_PROGRESS,
      );
    }

    throw createSafeError(
      TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
    );
  }

  private async executeClaimedAttempt(
    record: TenantProvisioningInternalRecord,
    configuration: TenantProvisioningConfiguration,
    attemptCount: number,
  ): Promise<TenantProvisioningResult> {
    const keyMaterial = configuration.activeEncryptionKey.copyKeyMaterial();
    let plaintextPassword: string;

    try {
      plaintextPassword = this.encryptionService.decryptPassword(
        record.databasePasswordEncrypted!,
        record.encryptionKeyVersion!,
        {
          tenantDatabaseRecordId: record.id,
          storeId: record.storeId,
          databaseName: record.databaseName,
          databaseUser: record.databaseUser!,
          keyVersion: record.encryptionKeyVersion!,
        },
        keyMaterial,
      );
    } finally {
      keyMaterial.fill(0);
    }

    await this.postgresProvisioner.ensureTenantInfrastructure({
      postgresAdminUrl: configuration.postgresAdminUrl,
      storeId: record.storeId,
      databaseName: record.databaseName,
      databaseUser: record.databaseUser!,
      plaintextPassword,
      connectionTimeoutMs: configuration.tenantPostgresConnectionTimeoutMs,
    });

    const tenantDatabaseUrl = buildTenantDatabaseUrl({
      hostname: record.databaseHost!,
      port: record.databasePort!,
      databaseName: record.databaseName,
      databaseUser: record.databaseUser!,
      password: plaintextPassword,
      sslMode: configuration.tenantDatabaseSslMode,
    });

    await this.migrationRunner.runMigrations({
      tenantDatabaseUrl,
      tenantMigrationTimeoutMs: configuration.tenantMigrationTimeoutMs,
    });
    await this.identityInitializer.initializeAndVerify({
      tenantDatabaseUrl,
      storeId: record.storeId,
      connectionTimeoutMs: configuration.tenantPostgresConnectionTimeoutMs,
    });

    const ready = await this.prismaService.tenantDatabase.updateMany({
      where: {
        id: record.id,
        status: TenantProvisioningStatus.PROVISIONING,
        attemptCount,
      },
      data: {
        status: TenantProvisioningStatus.READY,
        provisionedAt: new Date(),
        failedAt: null,
        lastFailureCode: null,
        lastFailureMessage: null,
      },
    });

    if (ready.count !== 1) {
      throw createSafeError(
        TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
      );
    }

    const finalRecord = await this.prismaService.tenantDatabase.findUnique({
      where: { id: record.id },
      select: tenantProvisioningPublicSelect,
    });

    if (finalRecord?.status !== TenantProvisioningStatus.READY) {
      throw createSafeError(
        TenantProvisioningErrorCode.PROVISIONING_STATE_CONFLICT,
      );
    }

    return {
      provisioning: toPublicRecord(finalRecord),
      alreadyReady: false,
    };
  }

  private async persistFailure(
    recordId: string,
    attemptCount: number,
    error: TenantProvisioningError,
  ): Promise<void> {
    try {
      await this.prismaService.tenantDatabase.updateMany({
        where: {
          id: recordId,
          status: TenantProvisioningStatus.PROVISIONING,
          attemptCount,
        },
        data: {
          status: TenantProvisioningStatus.FAILED,
          failedAt: new Date(),
          provisionedAt: null,
          lastFailureCode: error.code,
          lastFailureMessage: getTenantProvisioningSafeMessage(error.code),
        },
      });
    } catch {
      // The original sanitized provisioning failure remains authoritative.
    }
  }
}

function assertRecordIntegrity(
  record: TenantProvisioningInternalRecord,
  storeId: string,
  identifiers: { databaseName: string; databaseUser: string },
  configuration: TenantProvisioningConfiguration,
): void {
  if (
    record.storeId !== storeId ||
    record.databaseName !== identifiers.databaseName ||
    record.databaseUser !== identifiers.databaseUser ||
    typeof record.databaseHost !== 'string' ||
    record.databaseHost.trim().length === 0 ||
    !Number.isInteger(record.databasePort) ||
    record.databasePort! < 1 ||
    record.databasePort! > 65535 ||
    typeof record.databasePasswordEncrypted !== 'string' ||
    record.databasePasswordEncrypted.length === 0 ||
    !Number.isInteger(record.encryptionKeyVersion) ||
    record.encryptionKeyVersion! < 1 ||
    !Number.isInteger(record.attemptCount) ||
    record.attemptCount < 0
  ) {
    throw createSafeError(
      TenantProvisioningErrorCode.RECORD_INTEGRITY_FAILED,
    );
  }

  if (
    normalizeHostname(record.databaseHost) !==
      normalizeHostname(configuration.tenantDatabaseHost) ||
    record.databasePort !== configuration.tenantDatabasePort
  ) {
    throw createSafeError(TenantProvisioningErrorCode.CONFIGURATION_DRIFT);
  }
}

function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();

  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }

  if (!normalized.includes(':') && normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }

  if (!normalized) {
    throw createSafeError(
      TenantProvisioningErrorCode.RECORD_INTEGRITY_FAILED,
    );
  }

  if (
    normalized === 'localhost' ||
    normalized.startsWith('127.') ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1'
  ) {
    return 'loopback';
  }

  return normalized;
}

function requireCanonicalUuidV4(value: string): string {
  if (typeof value !== 'string' || !CANONICAL_UUID_V4_PATTERN.test(value)) {
    throw createSafeError(TenantProvisioningErrorCode.IDENTIFIER_INVALID);
  }

  return value.toLowerCase();
}

function hasPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function sanitizeError(error: unknown): TenantProvisioningError {
  if (error instanceof TenantProvisioningError) {
    return createSafeError(error.code);
  }

  return createSafeError(TenantProvisioningErrorCode.PROVISIONING_FAILED);
}

function createSafeError(
  code: TenantProvisioningErrorCode,
): TenantProvisioningError {
  return createTenantProvisioningError(code);
}

function toPublicRecord(
  record: TenantProvisioningPublicRecord,
): TenantProvisioningPublicRecord {
  return {
    id: record.id,
    storeId: record.storeId,
    status: record.status,
    databaseName: record.databaseName,
    attemptCount: record.attemptCount,
    provisioningStartedAt: record.provisioningStartedAt,
    provisionedAt: record.provisionedAt,
    failedAt: record.failedAt,
    lastFailureCode: record.lastFailureCode,
    lastFailureMessage: record.lastFailureMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
