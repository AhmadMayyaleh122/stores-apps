import { Injectable } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import {
  Prisma,
  TenantProvisioningStatus,
} from '../../../../generated/prisma/client';
import {
  EmployeeStatus,
  PrismaClient as TenantPrismaClient,
} from '../../../../generated/tenant-prisma/client';
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
import { normalizeTenantOwnerEmail } from '../../tenant-provisioning/utils/tenant-owner-email.util';
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

interface LockedOwnerRow {
  id: string;
}

interface LockedRefreshSessionRow {
  id: string;
  employeeId: string;
}

interface DatabaseClockRow {
  authoritativeTime: Date;
}

interface ActivationOwnerRecord {
  id: string;
  status: EmployeeStatus;
  isStoreOwner: boolean;
  masterStoreId: string | null;
  role: {
    key: string;
    name: string;
    isSystem: boolean;
  };
  credential: { employeeId: string } | null;
}

interface ActivationTokenRecord {
  id: string;
  employeeId: string;
  tokenHash: Uint8Array;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

interface OwnerLoginRecord {
  id: string;
  email: string;
  roleId: string;
  status: EmployeeStatus;
  isStoreOwner: boolean;
  masterStoreId: string | null;
  role: {
    id: string;
    key: string;
    name: string;
    isSystem: boolean;
  };
  credential: {
    employeeId: string;
    passwordHash: string;
  } | null;
}

interface RefreshSessionRecord {
  id: string;
  employeeId: string;
  refreshTokenHash: Uint8Array;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface TenantStoreAuthTransactionBoundary {
  $queryRaw<T>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  tenantIdentity: {
    findUnique(options: {
      where: { id: number };
      select: { id: true; masterStoreId: true };
    }): Promise<TenantIdentityRecord | null>;
  };
  employee: {
    findUnique(options: {
      where: { id: string };
      select: typeof ACTIVATION_OWNER_SELECT;
    }): Promise<ActivationOwnerRecord | null>;
    updateMany(options: {
      where: {
        id: string;
        status: EmployeeStatus;
        isStoreOwner: true;
        masterStoreId: string;
      };
      data: { status: EmployeeStatus };
    }): Promise<{ count: number }>;
  };
  employeeCredential: {
    create(options: {
      data: {
        employeeId: string;
        passwordHash: string;
        passwordChangedAt: Date;
      };
      select: { employeeId: true };
    }): Promise<{ employeeId: string }>;
  };
  employeeActivationToken: {
    findUnique(options: {
      where: { tokenHash: Buffer };
      select: typeof ACTIVATION_TOKEN_SELECT;
    }): Promise<ActivationTokenRecord | null>;
    updateMany(options: {
      where: {
        id?: string;
        employeeId: string;
        tokenHash?: Buffer;
        consumedAt: null;
        revokedAt: null;
        expiresAt?: { gt: Date };
      };
      data: { consumedAt?: Date; revokedAt?: Date };
    }): Promise<{ count: number }>;
    create(options: {
      data: {
        employeeId: string;
        tokenHash: Buffer;
        expiresAt: Date;
        createdAt: Date;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
  employeeRefreshSession: {
    findUnique(options: {
      where: { id: string };
      select: typeof REFRESH_SESSION_SELECT;
    }): Promise<RefreshSessionRecord | null>;
    create(options: {
      data: {
        employeeId: string;
        refreshTokenHash: Buffer;
        issuedAt: Date;
        expiresAt: Date;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
    updateMany(options: {
      where: {
        id: string;
        employeeId: string;
        refreshTokenHash: Buffer;
        revokedAt: null;
        expiresAt?: { gt: Date };
      };
      data: {
        refreshTokenHash?: Buffer;
        issuedAt?: Date;
        expiresAt?: Date;
        revokedAt?: Date;
      };
    }): Promise<{ count: number }>;
  };
}

interface TenantStoreAuthPrismaClientBoundary {
  $transaction<T>(
    operation: (
      transaction: TenantStoreAuthTransactionBoundary,
    ) => Promise<T>,
  ): Promise<T>;
}

interface TenantStoreAuthAdvisoryClientBoundary {
  $queryRaw<T>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  employee: {
    findUnique(options: {
      where: { email: string };
      select: typeof OWNER_LOGIN_SELECT;
    }): Promise<OwnerLoginRecord | null>;
    findMany(options: {
      where: { isStoreOwner: true };
      select: typeof ACTIVATION_OWNER_SELECT;
      orderBy: { id: 'asc' };
      take: 2;
    }): Promise<ActivationOwnerRecord[]>;
  };
  employeeActivationToken: {
    findUnique(options: {
      where: { tokenHash: Buffer };
      select: typeof ACTIVATION_TOKEN_SELECT;
    }): Promise<ActivationTokenRecord | null>;
  };
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
  findOwnerLoginCredential(
    input: FindOwnerLoginCredentialInput,
  ): Promise<OwnerLoginCredential | null>;
  checkOwnerActivationEligibility(
    input: CheckOwnerActivationEligibilityInput,
  ): Promise<boolean>;
  issueOwnerActivation(
    input: IssueOwnerActivationMutation,
  ): Promise<OwnerActivationIssuanceOutcome>;
  activateOwner(input: ActivateOwnerMutation): Promise<ActivateOwnerOutcome>;
  createOwnerRefreshSession(
    input: CreateOwnerRefreshSessionInput,
  ): Promise<CreateOwnerRefreshSessionOutcome>;
  rotateOwnerRefreshSession(
    input: RotateOwnerRefreshSessionInput,
    issueAccessToken: RotatedOwnerAccessTokenIssuer,
  ): Promise<RotateOwnerRefreshSessionOutcome>;
}

export interface FindOwnerLoginCredentialInput {
  readonly email: string;
}

export interface OwnerLoginCredential {
  readonly ownerId: string;
  readonly email: string;
  readonly passwordHash: string;
}

export interface CheckOwnerActivationEligibilityInput {
  readonly tokenHash: Buffer;
}

export interface IssueOwnerActivationMutation {
  readonly tokenHash: Buffer;
  readonly ttlMinutes: number;
}

export interface ActivateOwnerMutation {
  readonly tokenHash: Buffer;
  readonly passwordHash: string;
}

export interface CreateOwnerRefreshSessionInput {
  readonly ownerId: string;
  readonly refreshTokenHash: Buffer;
  readonly ttlMinutes: number;
}

export interface OwnerRefreshSessionCreatedOutcome {
  readonly sessionId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type CreateOwnerRefreshSessionOutcome =
  | OwnerRefreshSessionCreatedOutcome
  | 'REFRESH_TOKEN_HASH_COLLISION';

export interface RotateOwnerRefreshSessionInput {
  readonly presentedRefreshTokenHash: Buffer;
  readonly replacementRefreshTokenHash: Buffer;
  readonly ttlMinutes: number;
}

export interface RotatedOwnerAccessTokenInput {
  readonly ownerId: string;
  readonly storeId: string;
  readonly sessionId: string;
  readonly issuedAt: Date;
}

export interface RotatedOwnerAccessToken {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

export type RotatedOwnerAccessTokenIssuer = (
  input: RotatedOwnerAccessTokenInput,
) => Promise<RotatedOwnerAccessToken>;

export interface OwnerRefreshSessionRotatedOutcome {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshTokenExpiresAt: Date;
}

export type RotateOwnerRefreshSessionOutcome =
  | OwnerRefreshSessionRotatedOutcome
  | 'INVALID_REFRESH'
  | 'INVALID_REFRESH_REVOKED'
  | 'REFRESH_TOKEN_HASH_COLLISION';

export interface OwnerActivationIssuedOutcome {
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface ActivateOwnerOutcome {
  readonly activatedAt: Date;
}

export type OwnerActivationIssuanceOutcome =
  | OwnerActivationIssuedOutcome
  | 'TOKEN_HASH_COLLISION';

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
    let committedSecurityMutation = false;

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
          tenantAccess: createStoreAuthTenantAccess(
            tenantPrisma,
            connection.storeId,
            () => {
              committedSecurityMutation = true;
            },
          ),
        }),
      );
    } catch (error) {
      failure = preserveStoreAuthError(error);
    } finally {
      try {
        await tenantPrisma.$disconnect();
      } catch {
        if (!failure && !committedSecurityMutation) {
          failure = createStoreAuthError(
            StoreAuthErrorCode.TENANT_CLEANUP_FAILED,
          );
        }
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

const ACTIVATION_OWNER_SELECT = {
  id: true,
  status: true,
  isStoreOwner: true,
  masterStoreId: true,
  role: {
    select: {
      key: true,
      name: true,
      isSystem: true,
    },
  },
  credential: {
    select: { employeeId: true },
  },
} as const;

const OWNER_LOGIN_SELECT = {
  id: true,
  email: true,
  roleId: true,
  status: true,
  isStoreOwner: true,
  masterStoreId: true,
  role: {
    select: {
      id: true,
      key: true,
      name: true,
      isSystem: true,
    },
  },
  credential: {
    select: {
      employeeId: true,
      passwordHash: true,
    },
  },
} as const;

const ACTIVATION_TOKEN_SELECT = {
  id: true,
  employeeId: true,
  tokenHash: true,
  expiresAt: true,
  consumedAt: true,
  revokedAt: true,
} as const;

const REFRESH_SESSION_SELECT = {
  id: true,
  employeeId: true,
  refreshTokenHash: true,
  issuedAt: true,
  expiresAt: true,
  revokedAt: true,
} as const;

function createStoreAuthTenantAccess(
  tenantPrisma: TenantPrismaClient,
  storeId: string,
  markCommittedSecurityMutation: () => void,
): StoreAuthTenantAccess {
  const internalClient =
    tenantPrisma as unknown as TenantStoreAuthPrismaClientBoundary;
  const advisoryClient =
    tenantPrisma as unknown as TenantStoreAuthAdvisoryClientBoundary;

  return Object.freeze(
    Object.assign(Object.create(null) as object, {
      kind: 'STORE_AUTH_TENANT_ACCESS' as const,
      findOwnerLoginCredential: async (
        input: FindOwnerLoginCredentialInput,
      ) => findOwnerLoginCredential(advisoryClient, storeId, input),
      checkOwnerActivationEligibility: async (
        input: CheckOwnerActivationEligibilityInput,
      ) =>
        checkOwnerActivationEligibility(advisoryClient, storeId, input),
      issueOwnerActivation: async (input: IssueOwnerActivationMutation) => {
        const outcome = await issueOwnerActivationMutation(
          internalClient,
          storeId,
          input,
        );

        if (outcome !== 'TOKEN_HASH_COLLISION') {
          markCommittedSecurityMutation();
        }

        return outcome;
      },
      activateOwner: async (input: ActivateOwnerMutation) => {
        const outcome = await activateOwnerMutation(
          internalClient,
          storeId,
          input,
        );
        markCommittedSecurityMutation();
        return outcome;
      },
      createOwnerRefreshSession: async (
        input: CreateOwnerRefreshSessionInput,
      ) => {
        const outcome = await createOwnerRefreshSessionMutation(
          internalClient,
          storeId,
          input,
        );

        if (outcome !== 'REFRESH_TOKEN_HASH_COLLISION') {
          markCommittedSecurityMutation();
        }

        return outcome;
      },
      rotateOwnerRefreshSession: async (
        input: RotateOwnerRefreshSessionInput,
        issueAccessToken: RotatedOwnerAccessTokenIssuer,
      ) => {
        const outcome = await rotateOwnerRefreshSessionMutation(
          internalClient,
          storeId,
          input,
          issueAccessToken,
        );

        if (
          outcome !== 'INVALID_REFRESH' &&
          outcome !== 'REFRESH_TOKEN_HASH_COLLISION'
        ) {
          markCommittedSecurityMutation();
        }

        return outcome;
      },
    }),
  ) as StoreAuthTenantAccess;
}

async function rotateOwnerRefreshSessionMutation(
  tenantPrisma: TenantStoreAuthPrismaClientBoundary,
  storeId: string,
  input: RotateOwnerRefreshSessionInput,
  issueAccessToken: RotatedOwnerAccessTokenIssuer,
): Promise<RotateOwnerRefreshSessionOutcome> {
  let presentedHash: Buffer | undefined;
  let replacementHash: Buffer | undefined;

  try {
    presentedHash = copyRefreshTokenHash(
      input.presentedRefreshTokenHash,
    );
    replacementHash = copyRefreshTokenHash(
      input.replacementRefreshTokenHash,
    );
    const usablePresentedHash = presentedHash;
    const usableReplacementHash = replacementHash;
    const ttlMinutes = requireSessionTtl(input.ttlMinutes);

    if (
      usablePresentedHash.equals(usableReplacementHash) ||
      typeof issueAccessToken !== 'function'
    ) {
      throw refreshFailed();
    }

    return await tenantPrisma.$transaction(async (transaction) => {
      const lockedSessions = await transaction.$queryRaw<
        LockedRefreshSessionRow[]
      >`
        SELECT "id", "employee_id" AS "employeeId"
        FROM "employee_refresh_sessions"
        WHERE "refresh_token_hash" = ${usablePresentedHash}
        FOR UPDATE
      `;

      if (lockedSessions.length !== 1) {
        return 'INVALID_REFRESH';
      }

      let sessionId: string;
      let ownerId: string;

      try {
        sessionId = normalizeCanonicalUuid(lockedSessions[0].id);
        ownerId = normalizeCanonicalUuid(lockedSessions[0].employeeId);
      } catch {
        return 'INVALID_REFRESH';
      }

      const lockedOwners = await transaction.$queryRaw<LockedOwnerRow[]>`
        SELECT "id"
        FROM "employees"
        WHERE "id" = ${ownerId}
        FOR UPDATE
      `;

      if (
        lockedOwners.length !== 1 ||
        normalizeCanonicalUuid(lockedOwners[0].id) !== ownerId
      ) {
        return 'INVALID_REFRESH';
      }

      await requireTransactionTenantIdentity(
        transaction,
        storeId,
        StoreAuthErrorCode.AUTH_REFRESH_INVALID,
      );
      const session = await transaction.employeeRefreshSession.findUnique({
        where: { id: sessionId },
        select: REFRESH_SESSION_SELECT,
      });
      const owner = await transaction.employee.findUnique({
        where: { id: ownerId },
        select: ACTIVATION_OWNER_SELECT,
      });
      const refreshTime = await readAuthoritativeRefreshTime(transaction);

      if (
        !isMatchingRefreshSession(
          session,
          sessionId,
          ownerId,
          usablePresentedHash,
          refreshTime,
        )
      ) {
        return 'INVALID_REFRESH';
      }

      if (!isEligibleActiveSessionOwner(owner, storeId, ownerId)) {
        const revoked = await transaction.employeeRefreshSession.updateMany({
          where: {
            id: sessionId,
            employeeId: ownerId,
            refreshTokenHash: usablePresentedHash,
            revokedAt: null,
            expiresAt: { gt: refreshTime },
          },
          data: { revokedAt: refreshTime },
        });

        if (revoked.count !== 1) {
          throw refreshFailed();
        }

        return 'INVALID_REFRESH_REVOKED';
      }

      const replacementExpiresAt = calculateRefreshExpiration(
        refreshTime,
        ttlMinutes,
      );
      const rotated = await transaction.employeeRefreshSession.updateMany({
        where: {
          id: sessionId,
          employeeId: ownerId,
          refreshTokenHash: usablePresentedHash,
          revokedAt: null,
          expiresAt: { gt: refreshTime },
        },
        data: {
          refreshTokenHash: usableReplacementHash,
          issuedAt: refreshTime,
          expiresAt: replacementExpiresAt,
        },
      });

      if (rotated.count !== 1) {
        throw refreshInvalid();
      }

      const accessToken = await issueAccessToken(
        Object.freeze({
          ownerId,
          storeId,
          sessionId,
          issuedAt: new Date(refreshTime.getTime()),
        }),
      );
      const accessTokenExpiresAt = requireValidAccessTokenResult(
        accessToken,
        refreshTime,
      );

      return Object.freeze({
        accessToken: accessToken.accessToken,
        accessTokenExpiresAt,
        refreshTokenExpiresAt: new Date(replacementExpiresAt.getTime()),
      });
    });
  } catch (error) {
    if (
      isUniqueConstraintViolationFor(
        error,
        'EmployeeRefreshSession',
        REFRESH_TOKEN_HASH_UNIQUE_TARGETS,
      )
    ) {
      return 'REFRESH_TOKEN_HASH_COLLISION';
    }

    if (
      error instanceof StoreAuthError &&
      error.code === StoreAuthErrorCode.AUTH_REFRESH_INVALID
    ) {
      throw createStoreAuthError(error.code);
    }

    throw refreshFailed();
  } finally {
    presentedHash?.fill(0);
    replacementHash?.fill(0);
  }
}

async function createOwnerRefreshSessionMutation(
  tenantPrisma: TenantStoreAuthPrismaClientBoundary,
  storeId: string,
  input: CreateOwnerRefreshSessionInput,
): Promise<CreateOwnerRefreshSessionOutcome> {
  const refreshTokenHash = copyRefreshTokenHash(input.refreshTokenHash);

  try {
    const ownerId = normalizeCanonicalUuid(input.ownerId);
    const ttlMinutes = requireSessionTtl(input.ttlMinutes);

    return await tenantPrisma.$transaction(async (transaction) => {
      const owner = await lockAndRequireActiveSessionOwner(
        transaction,
        storeId,
        ownerId,
      );
      const issuedAt = await readAuthoritativeSessionTime(transaction);
      const expiresAt = calculateSessionExpiration(issuedAt, ttlMinutes);
      const session = await transaction.employeeRefreshSession.create({
        data: {
          employeeId: owner.id,
          refreshTokenHash,
          issuedAt,
          expiresAt,
        },
        select: { id: true },
      });

      return Object.freeze({
        sessionId: normalizeCanonicalUuid(session.id),
        issuedAt: new Date(issuedAt.getTime()),
        expiresAt: new Date(expiresAt.getTime()),
      });
    });
  } catch (error) {
    if (
      isUniqueConstraintViolationFor(
        error,
        'EmployeeRefreshSession',
        REFRESH_TOKEN_HASH_UNIQUE_TARGETS,
      )
    ) {
      return 'REFRESH_TOKEN_HASH_COLLISION';
    }

    if (
      error instanceof StoreAuthError &&
      error.code === StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID
    ) {
      throw createStoreAuthError(error.code);
    }

    throw sessionCreationFailed();
  } finally {
    refreshTokenHash.fill(0);
  }
}

async function lockAndRequireActiveSessionOwner(
  transaction: TenantStoreAuthTransactionBoundary,
  storeId: string,
  ownerId: string,
): Promise<ActivationOwnerRecord> {
  const lockedOwners = await transaction.$queryRaw<LockedOwnerRow[]>`
    SELECT "id"
    FROM "employees"
    WHERE "id" = ${ownerId}
      AND "is_store_owner" = TRUE
    FOR UPDATE
  `;

  if (
    lockedOwners.length !== 1 ||
    normalizeCanonicalUuid(lockedOwners[0].id) !== ownerId
  ) {
    throw sessionOwnerInvalid();
  }

  await requireTransactionTenantIdentity(
    transaction,
    storeId,
    StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID,
  );
  const owner = await transaction.employee.findUnique({
    where: { id: ownerId },
    select: ACTIVATION_OWNER_SELECT,
  });

  if (!isEligibleActiveSessionOwner(owner, storeId, ownerId)) {
    throw sessionOwnerInvalid();
  }

  return owner;
}

function isEligibleActiveSessionOwner(
  owner: ActivationOwnerRecord | null,
  storeId: string,
  expectedOwnerId: string,
): owner is ActivationOwnerRecord {
  try {
    return (
      owner !== null &&
      normalizeCanonicalUuid(owner.id) === expectedOwnerId &&
      owner.status === EmployeeStatus.ACTIVE &&
      owner.isStoreOwner === true &&
      normalizeCanonicalUuid(owner.masterStoreId as string) === storeId &&
      owner.role.key === 'OWNER' &&
      owner.role.name === 'Owner' &&
      owner.role.isSystem === true &&
      normalizeCanonicalUuid(owner.credential?.employeeId as string) ===
        expectedOwnerId
    );
  } catch {
    return false;
  }
}

function isMatchingRefreshSession(
  session: RefreshSessionRecord | null,
  expectedSessionId: string,
  expectedOwnerId: string,
  expectedHash: Buffer,
  refreshTime: Date,
): session is RefreshSessionRecord {
  try {
    return (
      session !== null &&
      normalizeCanonicalUuid(session.id) === expectedSessionId &&
      normalizeCanonicalUuid(session.employeeId) === expectedOwnerId &&
      Buffer.from(session.refreshTokenHash).equals(expectedHash) &&
      session.issuedAt instanceof Date &&
      Number.isFinite(session.issuedAt.getTime()) &&
      session.issuedAt.getTime() <= refreshTime.getTime() &&
      session.expiresAt instanceof Date &&
      Number.isFinite(session.expiresAt.getTime()) &&
      session.expiresAt.getTime() > refreshTime.getTime() &&
      session.revokedAt === null
    );
  } catch {
    return false;
  }
}

async function findOwnerLoginCredential(
  tenantPrisma: TenantStoreAuthAdvisoryClientBoundary,
  storeId: string,
  input: FindOwnerLoginCredentialInput,
): Promise<OwnerLoginCredential | null> {
  const canonicalEmail = normalizeTenantOwnerEmail(input.email);

  if (canonicalEmail === null) {
    throw createStoreAuthError(StoreAuthErrorCode.INVALID_STORE_CREDENTIALS);
  }

  const owner = await tenantPrisma.employee.findUnique({
    where: { email: canonicalEmail },
    select: OWNER_LOGIN_SELECT,
  });

  if (!isEligibleLoginOwner(owner, storeId, canonicalEmail)) {
    return null;
  }

  return Object.freeze({
    ownerId: normalizeCanonicalUuid(owner.id),
    email: owner.email,
    passwordHash: owner.credential.passwordHash,
  });
}

function isEligibleLoginOwner(
  owner: OwnerLoginRecord | null,
  storeId: string,
  canonicalEmail: string,
): owner is OwnerLoginRecord & {
  credential: NonNullable<OwnerLoginRecord['credential']>;
} {
  try {
    return (
      owner !== null &&
      normalizeCanonicalUuid(owner.id) ===
        normalizeCanonicalUuid(owner.credential?.employeeId as string) &&
      owner.email === canonicalEmail &&
      owner.status === EmployeeStatus.ACTIVE &&
      owner.isStoreOwner === true &&
      normalizeCanonicalUuid(owner.masterStoreId as string) === storeId &&
      normalizeCanonicalUuid(owner.roleId) ===
        normalizeCanonicalUuid(owner.role.id) &&
      owner.role.key === 'OWNER' &&
      owner.role.name === 'Owner' &&
      owner.role.isSystem === true &&
      typeof owner.credential?.passwordHash === 'string' &&
      owner.credential.passwordHash.length > 0 &&
      owner.credential.passwordHash.length <= 255
    );
  } catch {
    return false;
  }
}

async function checkOwnerActivationEligibility(
  tenantPrisma: TenantStoreAuthAdvisoryClientBoundary,
  storeId: string,
  input: CheckOwnerActivationEligibilityInput,
): Promise<boolean> {
  const tokenHash = copyTokenHash(input.tokenHash, 'activation');

  try {
    const owners = await tenantPrisma.employee.findMany({
      where: { isStoreOwner: true },
      select: ACTIVATION_OWNER_SELECT,
      orderBy: { id: 'asc' },
      take: 2,
    });

    if (owners.length !== 1 || !isEligibleOwner(owners[0], storeId)) {
      return false;
    }

    const activationToken =
      await tenantPrisma.employeeActivationToken.findUnique({
        where: { tokenHash },
        select: ACTIVATION_TOKEN_SELECT,
      });

    if (!activationToken) {
      return false;
    }

    const advisoryTime = await readAuthoritativeDatabaseTime(
      tenantPrisma,
      'activation',
    );

    try {
      requireUsableActivationToken(
        activationToken,
        owners[0].id,
        tokenHash,
        advisoryTime,
      );
      return true;
    } catch {
      return false;
    }
  } finally {
    tokenHash.fill(0);
  }
}

async function issueOwnerActivationMutation(
  tenantPrisma: TenantStoreAuthPrismaClientBoundary,
  storeId: string,
  input: IssueOwnerActivationMutation,
): Promise<OwnerActivationIssuanceOutcome> {
  const tokenHash = copyTokenHash(input.tokenHash, 'issuance');

  try {
    const ttlMinutes = requirePositiveSafeInteger(input.ttlMinutes);

    return await tenantPrisma.$transaction(async (transaction) => {
      const owner = await lockAndRequireEligibleOwner(
        transaction,
        storeId,
        StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT,
      );
      const issuedAt = await readAuthoritativeDatabaseTime(
        transaction,
        'issuance',
      );
      const expiresAt = calculateExpiration(issuedAt, ttlMinutes);

      await transaction.employeeActivationToken.updateMany({
        where: {
          employeeId: owner.id,
          consumedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: issuedAt },
      });
      await transaction.employeeActivationToken.create({
        data: {
          employeeId: owner.id,
          tokenHash,
          expiresAt,
          createdAt: issuedAt,
        },
        select: { id: true },
      });

      return Object.freeze({
        issuedAt: new Date(issuedAt.getTime()),
        expiresAt: new Date(expiresAt.getTime()),
      });
    });
  } catch (error) {
    if (
      isUniqueConstraintViolationFor(
        error,
        'EmployeeActivationToken',
        TOKEN_HASH_UNIQUE_TARGETS,
      )
    ) {
      return 'TOKEN_HASH_COLLISION';
    }

    if (
      error instanceof StoreAuthError &&
      error.code === StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT
    ) {
      throw createStoreAuthError(error.code);
    }

    throw issuanceFailed();
  } finally {
    tokenHash.fill(0);
  }
}

async function activateOwnerMutation(
  tenantPrisma: TenantStoreAuthPrismaClientBoundary,
  storeId: string,
  input: ActivateOwnerMutation,
): Promise<ActivateOwnerOutcome> {
  const tokenHash = copyTokenHash(input.tokenHash, 'activation');

  try {
    if (
      typeof input.passwordHash !== 'string' ||
      input.passwordHash.length === 0 ||
      input.passwordHash.length > 255
    ) {
      throw activationFailed();
    }

    return await tenantPrisma.$transaction(async (transaction) => {
      const owner = await lockAndRequireEligibleOwner(
        transaction,
        storeId,
        StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
      );
      const activatedAt = await readAuthoritativeDatabaseTime(
        transaction,
        'activation',
      );
      const activationToken =
        await transaction.employeeActivationToken.findUnique({
          where: { tokenHash },
          select: ACTIVATION_TOKEN_SELECT,
        });

      requireUsableActivationToken(
        activationToken,
        owner.id,
        tokenHash,
        activatedAt,
      );

      const consumed = await transaction.employeeActivationToken.updateMany({
        where: {
          id: activationToken.id,
          employeeId: owner.id,
          tokenHash,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: activatedAt },
        },
        data: { consumedAt: activatedAt },
      });

      if (consumed.count !== 1) {
        throw activationInvalid();
      }

      await transaction.employeeCredential.create({
        data: {
          employeeId: owner.id,
          passwordHash: input.passwordHash,
          passwordChangedAt: activatedAt,
        },
        select: { employeeId: true },
      });

      const activated = await transaction.employee.updateMany({
        where: {
          id: owner.id,
          status: EmployeeStatus.PENDING_ACTIVATION,
          isStoreOwner: true,
          masterStoreId: storeId,
        },
        data: { status: EmployeeStatus.ACTIVE },
      });

      if (activated.count !== 1) {
        throw activationInvalid();
      }

      return Object.freeze({
        activatedAt: new Date(activatedAt.getTime()),
      });
    });
  } catch (error) {
    if (
      error instanceof StoreAuthError &&
      error.code === StoreAuthErrorCode.OWNER_ACTIVATION_INVALID
    ) {
      throw createStoreAuthError(error.code);
    }

    if (
      isUniqueConstraintViolationFor(
        error,
        'EmployeeCredential',
        CREDENTIAL_UNIQUE_TARGETS,
      )
    ) {
      throw activationInvalid();
    }

    throw activationFailed();
  } finally {
    tokenHash.fill(0);
  }
}

async function lockAndRequireEligibleOwner(
  transaction: TenantStoreAuthTransactionBoundary,
  storeId: string,
  invalidCode:
    | StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT
    | StoreAuthErrorCode.OWNER_ACTIVATION_INVALID,
): Promise<ActivationOwnerRecord> {
  const lockedOwners = await transaction.$queryRaw<LockedOwnerRow[]>`
    SELECT "id"
    FROM "employees"
    WHERE "is_store_owner" = TRUE
    ORDER BY "id"
    FOR UPDATE
  `;

  if (lockedOwners.length !== 1) {
    throw createStoreAuthError(invalidCode);
  }

  await requireTransactionTenantIdentity(transaction, storeId, invalidCode);

  const owner = await transaction.employee.findUnique({
    where: { id: lockedOwners[0].id },
    select: ACTIVATION_OWNER_SELECT,
  });

  if (
    !owner ||
    !isEligibleOwner(owner, storeId, lockedOwners[0].id)
  ) {
    throw createStoreAuthError(invalidCode);
  }

  return owner;
}

function isEligibleOwner(
  owner: ActivationOwnerRecord,
  storeId: string,
  expectedOwnerId = owner.id,
): boolean {
  try {
    return (
      normalizeCanonicalUuid(owner.id) ===
        normalizeCanonicalUuid(expectedOwnerId) &&
      owner.status === EmployeeStatus.PENDING_ACTIVATION &&
      owner.isStoreOwner === true &&
      normalizeCanonicalUuid(owner.masterStoreId as string) === storeId &&
      owner.role.key === 'OWNER' &&
      owner.role.name === 'Owner' &&
      owner.role.isSystem === true &&
      owner.credential === null
    );
  } catch {
    return false;
  }
}

async function requireTransactionTenantIdentity(
  transaction: TenantStoreAuthTransactionBoundary,
  storeId: string,
  invalidCode:
    | StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_CONFLICT
    | StoreAuthErrorCode.OWNER_ACTIVATION_INVALID
    | StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID
    | StoreAuthErrorCode.AUTH_REFRESH_INVALID,
): Promise<void> {
  const identity = await transaction.tenantIdentity.findUnique({
    where: { id: 1 },
    select: { id: true, masterStoreId: true },
  });

  try {
    if (
      identity?.id !== 1 ||
      normalizeCanonicalUuid(identity.masterStoreId) !== storeId
    ) {
      throw createStoreAuthError(invalidCode);
    }
  } catch {
    throw createStoreAuthError(invalidCode);
  }
}

function requireUsableActivationToken(
  token: ActivationTokenRecord | null,
  ownerId: string,
  expectedHash: Buffer,
  activatedAt: Date,
): asserts token is ActivationTokenRecord {
  if (
    !token ||
    token.employeeId !== ownerId ||
    !Buffer.from(token.tokenHash).equals(expectedHash) ||
    token.consumedAt !== null ||
    token.revokedAt !== null ||
    !(token.expiresAt instanceof Date) ||
    !Number.isFinite(token.expiresAt.getTime()) ||
    token.expiresAt.getTime() <= activatedAt.getTime()
  ) {
    throw activationInvalid();
  }
}

function copyTokenHash(
  value: unknown,
  operation: 'issuance' | 'activation',
): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw operation === 'issuance' ? issuanceFailed() : activationFailed();
  }

  return Buffer.from(value);
}

function copyRefreshTokenHash(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw sessionCreationFailed();
  }

  return Buffer.from(value);
}

async function readAuthoritativeDatabaseTime(
  client: Pick<TenantStoreAuthTransactionBoundary, '$queryRaw'>,
  operation: 'issuance' | 'activation',
): Promise<Date> {
  const rows = await client.$queryRaw<DatabaseClockRow[]>`
    SELECT date_trunc(
      'milliseconds',
      clock_timestamp() AT TIME ZONE 'UTC'
    ) AS "authoritativeTime"
  `;
  const authoritativeTime = rows[0]?.authoritativeTime;

  if (
    rows.length !== 1 ||
    !(authoritativeTime instanceof Date) ||
    !Number.isFinite(authoritativeTime.getTime())
  ) {
    throw operation === 'issuance' ? issuanceFailed() : activationFailed();
  }

  return new Date(authoritativeTime.getTime());
}

async function readAuthoritativeSessionTime(
  client: Pick<TenantStoreAuthTransactionBoundary, '$queryRaw'>,
): Promise<Date> {
  const rows = await client.$queryRaw<DatabaseClockRow[]>`
    SELECT date_trunc(
      'seconds',
      clock_timestamp() AT TIME ZONE 'UTC'
    ) AS "authoritativeTime"
  `;
  const authoritativeTime = rows[0]?.authoritativeTime;

  if (
    rows.length !== 1 ||
    !(authoritativeTime instanceof Date) ||
    !Number.isFinite(authoritativeTime.getTime()) ||
    authoritativeTime.getTime() % 1_000 !== 0
  ) {
    throw sessionCreationFailed();
  }

  return new Date(authoritativeTime.getTime());
}

async function readAuthoritativeRefreshTime(
  client: Pick<TenantStoreAuthTransactionBoundary, '$queryRaw'>,
): Promise<Date> {
  const rows = await client.$queryRaw<DatabaseClockRow[]>`
    SELECT date_trunc(
      'seconds',
      clock_timestamp() AT TIME ZONE 'UTC'
    ) AS "authoritativeTime"
  `;
  const authoritativeTime = rows[0]?.authoritativeTime;

  if (
    rows.length !== 1 ||
    !(authoritativeTime instanceof Date) ||
    !Number.isFinite(authoritativeTime.getTime()) ||
    authoritativeTime.getTime() % 1_000 !== 0
  ) {
    throw refreshFailed();
  }

  return new Date(authoritativeTime.getTime());
}

function requirePositiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw issuanceFailed();
  }

  return value as number;
}

function calculateExpiration(issuedAt: Date, ttlMinutes: number): Date {
  const ttlMilliseconds = ttlMinutes * 60_000;
  const expiresAtMilliseconds = issuedAt.getTime() + ttlMilliseconds;
  const expiresAt = new Date(expiresAtMilliseconds);

  if (
    !Number.isSafeInteger(ttlMilliseconds) ||
    !Number.isSafeInteger(expiresAtMilliseconds) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= issuedAt.getTime()
  ) {
    throw issuanceFailed();
  }

  return expiresAt;
}

function requireSessionTtl(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw sessionCreationFailed();
  }

  return value as number;
}

function calculateSessionExpiration(
  issuedAt: Date,
  ttlMinutes: number,
): Date {
  const ttlMilliseconds = ttlMinutes * 60_000;
  const expiresAtMilliseconds = issuedAt.getTime() + ttlMilliseconds;
  const expiresAt = new Date(expiresAtMilliseconds);

  if (
    !Number.isSafeInteger(ttlMilliseconds) ||
    !Number.isSafeInteger(expiresAtMilliseconds) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= issuedAt.getTime()
  ) {
    throw sessionCreationFailed();
  }

  return expiresAt;
}

function calculateRefreshExpiration(
  issuedAt: Date,
  ttlMinutes: number,
): Date {
  const ttlMilliseconds = ttlMinutes * 60_000;
  const expiresAtMilliseconds = issuedAt.getTime() + ttlMilliseconds;
  const expiresAt = new Date(expiresAtMilliseconds);

  if (
    !Number.isSafeInteger(ttlMilliseconds) ||
    !Number.isSafeInteger(expiresAtMilliseconds) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= issuedAt.getTime()
  ) {
    throw refreshFailed();
  }

  return expiresAt;
}

function requireValidAccessTokenResult(
  value: unknown,
  issuedAt: Date,
): Date {
  if (typeof value !== 'object' || value === null) {
    throw refreshFailed();
  }

  const result = value as Record<string, unknown>;

  if (
    typeof result.accessToken !== 'string' ||
    result.accessToken.length === 0 ||
    !(result.expiresAt instanceof Date) ||
    !Number.isFinite(result.expiresAt.getTime()) ||
    result.expiresAt.getTime() <= issuedAt.getTime()
  ) {
    throw refreshFailed();
  }

  return new Date(result.expiresAt.getTime());
}

const TOKEN_HASH_UNIQUE_TARGETS = new Set([
  'tokenHash',
  'token_hash',
  'employee_activation_tokens_token_hash_key',
]);

const CREDENTIAL_UNIQUE_TARGETS = new Set([
  'employeeId',
  'employee_id',
  'employee_credentials_pkey',
]);

const REFRESH_TOKEN_HASH_UNIQUE_TARGETS = new Set([
  'refreshTokenHash',
  'refresh_token_hash',
  'employee_refresh_sessions_refresh_token_hash_key',
]);

function isUniqueConstraintViolationFor(
  error: unknown,
  expectedModelName:
    | 'EmployeeActivationToken'
    | 'EmployeeCredential'
    | 'EmployeeRefreshSession',
  allowedTargets: ReadonlySet<string>,
): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'P2002' ||
    !('meta' in error) ||
    typeof error.meta !== 'object' ||
    error.meta === null
  ) {
    return false;
  }

  if (
    'modelName' in error.meta &&
    error.meta.modelName !== expectedModelName
  ) {
    return false;
  }

  const legacyTarget =
    'target' in error.meta
      ? normalizeUniqueConstraintTarget(error.meta.target)
      : undefined;

  if (legacyTarget) {
    return allowedTargets.has(legacyTarget);
  }

  if (
    !('driverAdapterError' in error.meta) ||
    typeof error.meta.driverAdapterError !== 'object' ||
    error.meta.driverAdapterError === null ||
    !('cause' in error.meta.driverAdapterError) ||
    typeof error.meta.driverAdapterError.cause !== 'object' ||
    error.meta.driverAdapterError.cause === null ||
    !('kind' in error.meta.driverAdapterError.cause) ||
    error.meta.driverAdapterError.cause.kind !==
      'UniqueConstraintViolation' ||
    !('constraint' in error.meta.driverAdapterError.cause) ||
    typeof error.meta.driverAdapterError.cause.constraint !== 'object' ||
    error.meta.driverAdapterError.cause.constraint === null
  ) {
    return false;
  }

  const constraint = error.meta.driverAdapterError.cause.constraint;
  const adapterTarget =
    'fields' in constraint
      ? normalizeUniqueConstraintTarget(constraint.fields)
      : 'index' in constraint
        ? normalizeUniqueConstraintTarget(constraint.index)
        : undefined;

  return adapterTarget !== undefined && allowedTargets.has(adapterTarget);
}

function normalizeUniqueConstraintTarget(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === 'string'
  ) {
    return value[0];
  }

  return undefined;
}

function issuanceFailed(): StoreAuthError {
  return createStoreAuthError(
    StoreAuthErrorCode.OWNER_ACTIVATION_ISSUANCE_FAILED,
  );
}

function activationInvalid(): StoreAuthError {
  return createStoreAuthError(StoreAuthErrorCode.OWNER_ACTIVATION_INVALID);
}

function activationFailed(): StoreAuthError {
  return createStoreAuthError(StoreAuthErrorCode.OWNER_ACTIVATION_FAILED);
}

function sessionOwnerInvalid(): StoreAuthError {
  return createStoreAuthError(StoreAuthErrorCode.AUTH_SESSION_OWNER_INVALID);
}

function sessionCreationFailed(): StoreAuthError {
  return createStoreAuthError(
    StoreAuthErrorCode.AUTH_SESSION_CREATION_FAILED,
  );
}

function refreshInvalid(): StoreAuthError {
  return createStoreAuthError(StoreAuthErrorCode.AUTH_REFRESH_INVALID);
}

function refreshFailed(): StoreAuthError {
  return createStoreAuthError(StoreAuthErrorCode.AUTH_REFRESH_FAILED);
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
