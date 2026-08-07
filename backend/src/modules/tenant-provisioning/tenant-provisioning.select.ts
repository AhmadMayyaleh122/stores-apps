import { Prisma } from '../../../generated/prisma/client';

export const tenantProvisioningPublicSelect = {
  id: true,
  storeId: true,
  status: true,
  databaseName: true,
  attemptCount: true,
  provisioningStartedAt: true,
  provisionedAt: true,
  failedAt: true,
  lastFailureCode: true,
  lastFailureMessage: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TenantDatabaseSelect;

export type TenantProvisioningPublicRecord =
  Prisma.TenantDatabaseGetPayload<{
    select: typeof tenantProvisioningPublicSelect;
  }>;

export const tenantProvisioningInternalSelect = {
  ...tenantProvisioningPublicSelect,
  databaseHost: true,
  databasePort: true,
  databaseUser: true,
  databasePasswordEncrypted: true,
  encryptionKeyVersion: true,
} satisfies Prisma.TenantDatabaseSelect;

export type TenantProvisioningInternalRecord =
  Prisma.TenantDatabaseGetPayload<{
    select: typeof tenantProvisioningInternalSelect;
  }>;
