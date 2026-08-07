import { Injectable } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient as TenantPrismaClient } from '../../../../generated/tenant-prisma/client';
import {
  createTenantProvisioningError,
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning.errors';
import { normalizeCanonicalUuid } from '../utils/tenant-database-identifier.util';

interface TenantIdentityRecord {
  id: number;
  masterStoreId: string;
}

interface TenantPrismaClientBoundary {
  tenantIdentity: {
    findUnique(options: {
      where: { id: number };
      select: { id: true; masterStoreId: true };
    }): Promise<TenantIdentityRecord | null>;
    create(options: {
      data: { id: number; masterStoreId: string };
      select: { id: true; masterStoreId: true };
    }): Promise<TenantIdentityRecord>;
  };
  $disconnect(): Promise<void>;
}

export interface InitializeTenantIdentityOptions {
  tenantDatabaseUrl: string;
  storeId: string;
  connectionTimeoutMs: number;
}

@Injectable()
export class TenantIdentityInitializerService {
  async initializeAndVerify(
    options: InitializeTenantIdentityOptions,
  ): Promise<void> {
    const storeId = normalizeCanonicalUuid(options.storeId);

    if (
      typeof options.tenantDatabaseUrl !== 'string' ||
      options.tenantDatabaseUrl.trim().length === 0 ||
      !Number.isInteger(options.connectionTimeoutMs) ||
      options.connectionTimeoutMs < 1
    ) {
      throw createIdentityError(
        TenantProvisioningErrorCode.IDENTITY_INITIALIZATION_FAILED,
      );
    }

    let tenantPrisma: TenantPrismaClientBoundary;

    try {
      tenantPrisma = this.createTenantPrismaClient(
        options.tenantDatabaseUrl,
        options.connectionTimeoutMs,
      );
    } catch {
      throw createIdentityError(
        TenantProvisioningErrorCode.IDENTITY_INITIALIZATION_FAILED,
      );
    }

    let failure: TenantProvisioningError | undefined;

    try {
      const existingIdentity = await readIdentityForInitialization(tenantPrisma);

      if (existingIdentity) {
        requireMatchingIdentity(existingIdentity, storeId);
      } else {
        try {
          await tenantPrisma.tenantIdentity.create({
            data: {
              id: 1,
              masterStoreId: storeId,
            },
            select: {
              id: true,
              masterStoreId: true,
            },
          });
        } catch (error) {
          if (!isUniqueConstraintViolation(error)) {
            throw createIdentityError(
              TenantProvisioningErrorCode.IDENTITY_INITIALIZATION_FAILED,
            );
          }

          const racedIdentity =
            await readIdentityForInitialization(tenantPrisma);
          requireMatchingIdentity(racedIdentity, storeId);
        }
      }

      const finalIdentity = await readIdentityForVerification(tenantPrisma);

      if (
        finalIdentity?.id !== 1 ||
        finalIdentity.masterStoreId !== storeId
      ) {
        throw createIdentityError(
          TenantProvisioningErrorCode.VERIFICATION_FAILED,
        );
      }
    } catch (error) {
      failure = preserveIdentityError(error);
    } finally {
      try {
        await tenantPrisma.$disconnect();
      } catch {
        failure ??= createIdentityError(
          TenantProvisioningErrorCode.IDENTITY_CLEANUP_FAILED,
        );
      }
    }

    if (failure) {
      throw failure;
    }
  }

  protected createTenantPrismaClient(
    tenantDatabaseUrl: string,
    connectionTimeoutMs: number,
  ): TenantPrismaClientBoundary {
    const adapter = new PrismaPg({
      connectionString: tenantDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: connectionTimeoutMs,
    });

    return new TenantPrismaClient({ adapter });
  }
}

async function readIdentityForInitialization(
  tenantPrisma: TenantPrismaClientBoundary,
): Promise<TenantIdentityRecord | null> {
  try {
    return await readIdentity(tenantPrisma);
  } catch (error) {
    if (error instanceof TenantProvisioningError) {
      throw error;
    }

    throw createIdentityError(
      TenantProvisioningErrorCode.IDENTITY_INITIALIZATION_FAILED,
    );
  }
}

async function readIdentityForVerification(
  tenantPrisma: TenantPrismaClientBoundary,
): Promise<TenantIdentityRecord | null> {
  try {
    return await readIdentity(tenantPrisma);
  } catch {
    throw createIdentityError(TenantProvisioningErrorCode.VERIFICATION_FAILED);
  }
}

function readIdentity(
  tenantPrisma: TenantPrismaClientBoundary,
): Promise<TenantIdentityRecord | null> {
  return tenantPrisma.tenantIdentity.findUnique({
    where: { id: 1 },
    select: {
      id: true,
      masterStoreId: true,
    },
  });
}

function requireMatchingIdentity(
  identity: TenantIdentityRecord | null,
  storeId: string,
): void {
  if (
    identity?.id !== 1 ||
    identity.masterStoreId !== storeId
  ) {
    throw createIdentityError(TenantProvisioningErrorCode.IDENTITY_MISMATCH);
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

function preserveIdentityError(error: unknown): TenantProvisioningError {
  return error instanceof TenantProvisioningError
    ? error
    : createIdentityError(
        TenantProvisioningErrorCode.IDENTITY_INITIALIZATION_FAILED,
      );
}

function createIdentityError(
  code:
    | TenantProvisioningErrorCode.IDENTITY_MISMATCH
    | TenantProvisioningErrorCode.IDENTITY_INITIALIZATION_FAILED
    | TenantProvisioningErrorCode.VERIFICATION_FAILED
    | TenantProvisioningErrorCode.IDENTITY_CLEANUP_FAILED,
): TenantProvisioningError {
  return createTenantProvisioningError(code);
}
