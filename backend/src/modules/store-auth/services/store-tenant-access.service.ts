import { Injectable } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import {
  Prisma,
  TenantProvisioningStatus,
} from '../../../../generated/prisma/client';
import { PrismaClient as TenantPrismaClient } from '../../../../generated/tenant-prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { TenantCredentialEncryptionService } from '../../tenant-provisioning/services/tenant-credential-encryption.service';
import {
  TenantAccessConfiguration,
  TenantProvisioningConfigService,
} from '../../tenant-provisioning/services/tenant-provisioning-config.service';
import {
  normalizeCanonicalUuid,
  validatePostgresIdentifier,
} from '../../tenant-provisioning/utils/tenant-database-identifier.util';
import {
  buildTenantDatabaseUrl,
  normalizeTenantDatabaseHostname,
} from '../../tenant-provisioning/utils/tenant-database-url.util';
import {
  createStoreAuthError,
  STORE_AUTH_SAFE_MESSAGES,
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';

const STORE_SLUG_MIN_LENGTH = 2;
const STORE_SLUG_MAX_LENGTH = 80;
const CANONICAL_STORE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const STORE_TENANT_ACCESS_SELECT = {
  id: true,
  storeSlug: true,
  tenantDatabase: {
    select: {
      id: true,
      storeId: true,
      status: true,
      databaseName: true,
      databaseHost: true,
      databasePort: true,
      databaseUser: true,
      databasePasswordEncrypted: true,
      encryptionKeyVersion: true,
    },
  },
} satisfies Prisma.StoreSelect;

type StoreTenantAccessRecord = Prisma.StoreGetPayload<{
  select: typeof STORE_TENANT_ACCESS_SELECT;
}>;

interface TenantIdentityRecord {
  id: number;
  masterStoreId: string;
}

interface TenantIdentityClientBoundary {
  tenantIdentity: {
    findUnique(options: {
      where: { id: number };
      select: { id: true; masterStoreId: true };
    }): Promise<TenantIdentityRecord | null>;
  };
  $disconnect(): Promise<void>;
}

interface ResolvedTenantConnection {
  storeId: string;
  tenantDatabaseUrl: string;
  connectionTimeoutMs: number;
}

export interface VerifiedStoreTenantContext {
  readonly storeId: string;
  readonly tenantAccess: StoreAuthTenantAccess;
}

export interface StoreAuthTenantAccess {
  readonly kind: 'STORE_AUTH_TENANT_ACCESS';
}

export type VerifiedStoreTenantOperation<T> = (
  context: VerifiedStoreTenantContext,
) => T | Promise<T>;

@Injectable()
export class StoreTenantAccessService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: TenantProvisioningConfigService,
    private readonly credentialEncryptionService: TenantCredentialEncryptionService,
  ) {}

  async withResolvedTenant<T>(
    storeSlug: unknown,
    operation: VerifiedStoreTenantOperation<T>,
  ): Promise<T> {
    const canonicalStoreSlug = requireCanonicalStoreSlug(storeSlug);
    const connection = await this.resolveTenantConnection(canonicalStoreSlug);
    let tenantPrisma: TenantPrismaClient;

    try {
      tenantPrisma = this.createTenantPrismaClient(
        connection.tenantDatabaseUrl,
        connection.connectionTimeoutMs,
      );
    } catch {
      throw createStoreAuthError(StoreAuthErrorCode.TENANT_ACCESS_FAILED);
    }

    let result: T | undefined;
    let failure: StoreAuthError | undefined;

    try {
      await verifyTenantIdentity(tenantPrisma, connection.storeId);
      result = await operation(
        Object.freeze({
          storeId: connection.storeId,
          tenantAccess: createStoreAuthTenantAccess(),
        }),
      );
    } catch (error) {
      failure = preserveStoreAuthError(error);
    } finally {
      try {
        await tenantPrisma.$disconnect();
      } catch {
        failure ??= createStoreAuthError(
          StoreAuthErrorCode.TENANT_CLEANUP_FAILED,
        );
      }
    }

    if (failure) {
      throw failure;
    }

    return result as T;
  }

  protected createTenantPrismaClient(
    tenantDatabaseUrl: string,
    connectionTimeoutMs: number,
  ): TenantPrismaClient {
    const adapter = new PrismaPg({
      connectionString: tenantDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: connectionTimeoutMs,
    });

    return new TenantPrismaClient({ adapter });
  }

  private async resolveTenantConnection(
    storeSlug: string,
  ): Promise<ResolvedTenantConnection> {
    let store: StoreTenantAccessRecord | null;

    try {
      store = await this.prismaService.store.findUnique({
        where: { storeSlug },
        select: STORE_TENANT_ACCESS_SELECT,
      });
    } catch {
      throw createStoreAuthError(StoreAuthErrorCode.TENANT_ACCESS_FAILED);
    }

    if (
      !store?.tenantDatabase ||
      store.tenantDatabase.status !== TenantProvisioningStatus.READY
    ) {
      throw createStoreAuthError(StoreAuthErrorCode.TENANT_UNAVAILABLE);
    }

    return this.buildResolvedTenantConnection(
      store,
      store.tenantDatabase,
      storeSlug,
    );
  }

  private buildResolvedTenantConnection(
    store: StoreTenantAccessRecord,
    tenantDatabase: NonNullable<StoreTenantAccessRecord['tenantDatabase']>,
    storeSlug: string,
  ): ResolvedTenantConnection {
    try {
      const storeId = normalizeCanonicalUuid(store.id);
      const tenantStoreId = normalizeCanonicalUuid(tenantDatabase.storeId);
      normalizeCanonicalUuid(tenantDatabase.id);
      const databaseName = validatePostgresIdentifier(
        tenantDatabase.databaseName,
      );
      const databaseUser = validatePostgresIdentifier(
        tenantDatabase.databaseUser as string,
      );

      if (
        store.storeSlug !== storeSlug ||
        tenantStoreId !== storeId ||
        typeof tenantDatabase.databaseHost !== 'string' ||
        tenantDatabase.databaseHost.trim().length === 0 ||
        !Number.isInteger(tenantDatabase.databasePort) ||
        tenantDatabase.databasePort! < 1 ||
        tenantDatabase.databasePort! > 65535 ||
        typeof tenantDatabase.databasePasswordEncrypted !== 'string' ||
        tenantDatabase.databasePasswordEncrypted.length === 0 ||
        !Number.isInteger(tenantDatabase.encryptionKeyVersion) ||
        tenantDatabase.encryptionKeyVersion! < 1
      ) {
        throw createStoreAuthError(
          StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
        );
      }

      const configuration = this.configService.getTenantAccessConfiguration(
        tenantDatabase.encryptionKeyVersion,
      );
      assertConnectionConfigurationMatches(
        tenantDatabase.databaseHost,
        tenantDatabase.databasePort!,
        configuration,
      );
      const plaintextPassword = this.decryptTenantPassword(
        tenantDatabase,
        storeId,
        databaseName,
        databaseUser,
        configuration,
      );
      const tenantDatabaseUrl = buildTenantDatabaseUrl({
        hostname: configuration.tenantDatabaseHost,
        port: configuration.tenantDatabasePort,
        databaseName,
        databaseUser,
        password: plaintextPassword,
        sslMode: configuration.tenantDatabaseSslMode,
      });

      return {
        storeId,
        tenantDatabaseUrl,
        connectionTimeoutMs:
          configuration.tenantPostgresConnectionTimeoutMs,
      };
    } catch (error) {
      if (error instanceof StoreAuthError) {
        throw error;
      }

      throw createStoreAuthError(
        StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
      );
    }
  }

  private decryptTenantPassword(
    tenantDatabase: NonNullable<StoreTenantAccessRecord['tenantDatabase']>,
    storeId: string,
    databaseName: string,
    databaseUser: string,
    configuration: TenantAccessConfiguration,
  ): string {
    const encryptionKey = configuration.encryptionKey.copyKeyMaterial();

    try {
      return this.credentialEncryptionService.decryptPassword(
        tenantDatabase.databasePasswordEncrypted!,
        configuration.encryptionKeyVersion,
        {
          tenantDatabaseRecordId: tenantDatabase.id,
          storeId,
          databaseName,
          databaseUser,
          keyVersion: configuration.encryptionKeyVersion,
        },
        encryptionKey,
      );
    } finally {
      encryptionKey.fill(0);
    }
  }
}

function createStoreAuthTenantAccess(): StoreAuthTenantAccess {
  return Object.freeze(
    Object.assign(Object.create(null) as object, {
      kind: 'STORE_AUTH_TENANT_ACCESS' as const,
    }),
  ) as StoreAuthTenantAccess;
}

function requireCanonicalStoreSlug(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < STORE_SLUG_MIN_LENGTH ||
    value.length > STORE_SLUG_MAX_LENGTH ||
    !CANONICAL_STORE_SLUG_PATTERN.test(value)
  ) {
    throw createStoreAuthError(StoreAuthErrorCode.STORE_SLUG_INVALID);
  }

  return value;
}

function assertConnectionConfigurationMatches(
  storedHostname: string,
  storedPort: number,
  configuration: TenantAccessConfiguration,
): void {
  if (
    normalizeTenantDatabaseHostname(storedHostname) !==
      normalizeTenantDatabaseHostname(configuration.tenantDatabaseHost) ||
    storedPort !== configuration.tenantDatabasePort
  ) {
    throw createStoreAuthError(
      StoreAuthErrorCode.TENANT_CONFIGURATION_INVALID,
    );
  }
}

async function verifyTenantIdentity(
  tenantPrisma: TenantIdentityClientBoundary,
  expectedStoreId: string,
): Promise<void> {
  let identity: TenantIdentityRecord | null;

  try {
    identity = await tenantPrisma.tenantIdentity.findUnique({
      where: { id: 1 },
      select: { id: true, masterStoreId: true },
    });
  } catch {
    throw createStoreAuthError(StoreAuthErrorCode.TENANT_ACCESS_FAILED);
  }

  try {
    if (
      identity?.id !== 1 ||
      normalizeCanonicalUuid(identity.masterStoreId) !== expectedStoreId
    ) {
      throw createStoreAuthError(StoreAuthErrorCode.TENANT_IDENTITY_INVALID);
    }
  } catch (error) {
    if (error instanceof StoreAuthError) {
      throw error;
    }

    throw createStoreAuthError(StoreAuthErrorCode.TENANT_IDENTITY_INVALID);
  }
}

function preserveStoreAuthError(error: unknown): StoreAuthError {
  if (
    error instanceof StoreAuthError &&
    Object.prototype.hasOwnProperty.call(STORE_AUTH_SAFE_MESSAGES, error.code)
  ) {
    return createStoreAuthError(error.code);
  }

  return createStoreAuthError(StoreAuthErrorCode.TENANT_ACCESS_FAILED);
}
