import { Injectable } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  EmployeeStatus,
  PrismaClient as TenantPrismaClient,
} from '../../../../generated/tenant-prisma/client';
import {
  createTenantProvisioningError,
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning.errors';
import { normalizeCanonicalUuid } from '../utils/tenant-database-identifier.util';
import { normalizeTenantOwnerEmail } from '../utils/tenant-owner-email.util';

const OWNER_ROLE_KEY = 'OWNER';
const OWNER_ROLE_NAME = 'Owner';
const MAX_FULL_NAME_LENGTH = 120;
const MAX_PHONE_LENGTH = 40;
const MAX_UNIQUE_RACE_RETRIES = 2;

interface TenantIdentityRecord {
  id: number;
  masterStoreId: string;
}

interface OwnerRoleRecord {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
}

interface OwnerEmployeeRecord {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  roleId: string;
  status: EmployeeStatus;
  isStoreOwner: boolean;
  masterStoreId: string | null;
}

interface RoleSelect {
  id: true;
  key: true;
  name: true;
  isSystem: true;
}

interface EmployeeSelect {
  id: true;
  fullName: true;
  email: true;
  phone: true;
  roleId: true;
  status: true;
  isStoreOwner: true;
  masterStoreId: true;
}

interface TenantOwnerTransactionBoundary {
  tenantIdentity: {
    findUnique(options: {
      where: { id: number };
      select: { id: true; masterStoreId: true };
    }): Promise<TenantIdentityRecord | null>;
  };
  role: {
    findUnique(options: {
      where: { key: string };
      select: RoleSelect;
    }): Promise<OwnerRoleRecord | null>;
    create(options: {
      data: { key: string; name: string; isSystem: boolean };
      select: RoleSelect;
    }): Promise<OwnerRoleRecord>;
  };
  employee: {
    findUnique(options: {
      where: { masterStoreId?: string; email?: string };
      select: EmployeeSelect;
    }): Promise<OwnerEmployeeRecord | null>;
    findFirst(options: {
      where: { isStoreOwner: true };
      select: EmployeeSelect;
    }): Promise<OwnerEmployeeRecord | null>;
    create(options: {
      data: {
        fullName: string;
        email: string;
        phone: string | null;
        roleId: string;
        status: EmployeeStatus;
        isStoreOwner: true;
        masterStoreId: string;
      };
      select: EmployeeSelect;
    }): Promise<OwnerEmployeeRecord>;
  };
}

interface TenantOwnerPrismaClientBoundary {
  $transaction<T>(
    callback: (transaction: TenantOwnerTransactionBoundary) => Promise<T>,
  ): Promise<T>;
  $disconnect(): Promise<void>;
}

interface CanonicalTenantOwnerOptions {
  tenantDatabaseUrl: string;
  storeId: string;
  fullName: string;
  email: string;
  phone: string | null;
  connectionTimeoutMs: number;
}

export interface InitializeTenantOwnerOptions {
  tenantDatabaseUrl: string;
  storeId: string;
  fullName: string;
  email: string;
  phone?: string | null;
  connectionTimeoutMs: number;
}

const ROLE_SELECT: RoleSelect = {
  id: true,
  key: true,
  name: true,
  isSystem: true,
};

const EMPLOYEE_SELECT: EmployeeSelect = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  roleId: true,
  status: true,
  isStoreOwner: true,
  masterStoreId: true,
};

class RelevantUniqueRaceError extends Error {
  constructor() {
    super('Relevant tenant owner unique race');
    this.name = 'RelevantUniqueRaceError';
  }
}

@Injectable()
export class TenantOwnerInitializerService {
  async initialize(options: InitializeTenantOwnerOptions): Promise<void> {
    const canonical = normalizeOptions(options);
    let tenantPrisma: TenantOwnerPrismaClientBoundary;

    try {
      tenantPrisma = this.createTenantPrismaClient(
        canonical.tenantDatabaseUrl,
        canonical.connectionTimeoutMs,
      );
    } catch {
      throw createOwnerError(
        TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
      );
    }

    let failure: TenantProvisioningError | undefined;

    try {
      await initializeWithRaceRecovery(tenantPrisma, canonical);
    } catch (error) {
      failure = preserveOwnerError(error);
    } finally {
      try {
        await tenantPrisma.$disconnect();
      } catch {
        failure ??= createOwnerError(
          TenantProvisioningErrorCode.OWNER_CLEANUP_FAILED,
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
  ): TenantOwnerPrismaClientBoundary {
    const adapter = new PrismaPg({
      connectionString: tenantDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: connectionTimeoutMs,
    });

    return new TenantPrismaClient({
      adapter,
    }) as unknown as TenantOwnerPrismaClientBoundary;
  }
}

async function initializeWithRaceRecovery(
  tenantPrisma: TenantOwnerPrismaClientBoundary,
  canonical: CanonicalTenantOwnerOptions,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_UNIQUE_RACE_RETRIES; attempt += 1) {
    try {
      await tenantPrisma.$transaction((transaction) =>
        initializeOwnerTransaction(transaction, canonical),
      );
      return;
    } catch (error) {
      if (!(error instanceof RelevantUniqueRaceError)) {
        throw error;
      }

      if (attempt === MAX_UNIQUE_RACE_RETRIES) {
        await tenantPrisma.$transaction((transaction) =>
          verifyFinalOwnerState(transaction, canonical),
        );
        return;
      }
    }
  }
}

async function initializeOwnerTransaction(
  transaction: TenantOwnerTransactionBoundary,
  canonical: CanonicalTenantOwnerOptions,
): Promise<void> {
  await requireMatchingTenantIdentity(transaction, canonical.storeId);
  const ownerRole = await resolveOwnerRole(transaction);
  await resolveOwnerEmployee(transaction, ownerRole.id, canonical);
}

async function verifyFinalOwnerState(
  transaction: TenantOwnerTransactionBoundary,
  canonical: CanonicalTenantOwnerOptions,
): Promise<void> {
  await requireMatchingTenantIdentity(transaction, canonical.storeId);
  const ownerRole = await transaction.role.findUnique({
    where: { key: OWNER_ROLE_KEY },
    select: ROLE_SELECT,
  });
  requireMatchingOwnerRole(ownerRole);

  const owner = await transaction.employee.findUnique({
    where: { masterStoreId: canonical.storeId },
    select: EMPLOYEE_SELECT,
  });
  requireMatchingOwner(owner, ownerRole.id, canonical);
}

async function requireMatchingTenantIdentity(
  transaction: TenantOwnerTransactionBoundary,
  storeId: string,
): Promise<void> {
  const identity = await transaction.tenantIdentity.findUnique({
    where: { id: 1 },
    select: { id: true, masterStoreId: true },
  });

  if (identity?.id !== 1 || identity.masterStoreId !== storeId) {
    throw createTenantProvisioningError(
      TenantProvisioningErrorCode.IDENTITY_MISMATCH,
    );
  }
}

async function resolveOwnerRole(
  transaction: TenantOwnerTransactionBoundary,
): Promise<OwnerRoleRecord> {
  const existingRole = await transaction.role.findUnique({
    where: { key: OWNER_ROLE_KEY },
    select: ROLE_SELECT,
  });

  if (existingRole) {
    requireMatchingOwnerRole(existingRole);
    return existingRole;
  }

  try {
    const createdRole = await transaction.role.create({
      data: {
        key: OWNER_ROLE_KEY,
        name: OWNER_ROLE_NAME,
        isSystem: true,
      },
      select: ROLE_SELECT,
    });
    requireMatchingOwnerRole(createdRole);
    return createdRole;
  } catch (error) {
    if (error instanceof TenantProvisioningError) {
      throw error;
    }

    if (isRelevantUniqueConstraintViolation(error, ROLE_UNIQUE_TARGETS)) {
      throw new RelevantUniqueRaceError();
    }

    throw createOwnerError(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );
  }
}

function requireMatchingOwnerRole(
  role: OwnerRoleRecord | null,
): asserts role is OwnerRoleRecord {
  if (
    role?.key !== OWNER_ROLE_KEY ||
    role.name !== OWNER_ROLE_NAME ||
    role.isSystem !== true
  ) {
    throw createOwnerError(TenantProvisioningErrorCode.OWNER_CONFLICT);
  }
}

async function resolveOwnerEmployee(
  transaction: TenantOwnerTransactionBoundary,
  ownerRoleId: string,
  canonical: CanonicalTenantOwnerOptions,
): Promise<void> {
  const ownerByStore = await transaction.employee.findUnique({
    where: { masterStoreId: canonical.storeId },
    select: EMPLOYEE_SELECT,
  });

  if (ownerByStore) {
    requireMatchingOwner(ownerByStore, ownerRoleId, canonical);
    return;
  }

  const designatedOwner = await transaction.employee.findFirst({
    where: { isStoreOwner: true },
    select: EMPLOYEE_SELECT,
  });

  if (designatedOwner) {
    throw createOwnerError(TenantProvisioningErrorCode.OWNER_CONFLICT);
  }

  const employeeByEmail = await transaction.employee.findUnique({
    where: { email: canonical.email },
    select: EMPLOYEE_SELECT,
  });

  if (employeeByEmail) {
    throw createOwnerError(TenantProvisioningErrorCode.OWNER_CONFLICT);
  }

  try {
    const createdOwner = await transaction.employee.create({
      data: {
        fullName: canonical.fullName,
        email: canonical.email,
        phone: canonical.phone,
        roleId: ownerRoleId,
        status: EmployeeStatus.PENDING_ACTIVATION,
        isStoreOwner: true,
        masterStoreId: canonical.storeId,
      },
      select: EMPLOYEE_SELECT,
    });
    requireMatchingOwner(createdOwner, ownerRoleId, canonical);
  } catch (error) {
    if (error instanceof TenantProvisioningError) {
      throw error;
    }

    if (isRelevantUniqueConstraintViolation(error, EMPLOYEE_UNIQUE_TARGETS)) {
      throw new RelevantUniqueRaceError();
    }

    throw createOwnerError(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );
  }
}

function requireMatchingOwner(
  owner: OwnerEmployeeRecord | null,
  ownerRoleId: string,
  canonical: CanonicalTenantOwnerOptions,
): asserts owner is OwnerEmployeeRecord {
  if (
    owner?.fullName !== canonical.fullName ||
    owner.email !== canonical.email ||
    owner.phone !== canonical.phone ||
    owner.roleId !== ownerRoleId ||
    owner.status !== EmployeeStatus.PENDING_ACTIVATION ||
    owner.isStoreOwner !== true ||
    owner.masterStoreId !== canonical.storeId
  ) {
    throw createOwnerError(TenantProvisioningErrorCode.OWNER_CONFLICT);
  }
}

const ROLE_UNIQUE_TARGETS = new Set(['key', 'roles_key_key']);
const EMPLOYEE_UNIQUE_TARGETS = new Set([
  'email',
  'masterStoreId',
  'master_store_id',
  'isStoreOwner',
  'is_store_owner',
  'employees_email_key',
  'employees_master_store_id_key',
  'employees_single_store_owner_key',
]);

function isRelevantUniqueConstraintViolation(
  error: unknown,
  allowedTargets: ReadonlySet<string>,
): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'P2002' ||
    !('meta' in error) ||
    typeof error.meta !== 'object' ||
    error.meta === null ||
    !('target' in error.meta)
  ) {
    return false;
  }

  const target = error.meta.target;
  const targets = Array.isArray(target) ? target : [target];

  return (
    targets.length > 0 &&
    targets.every(
      (candidate) =>
        typeof candidate === 'string' && allowedTargets.has(candidate),
    )
  );
}

function normalizeOptions(
  options: InitializeTenantOwnerOptions,
): CanonicalTenantOwnerOptions {
  const storeId = normalizeCanonicalUuid(options.storeId);
  const fullName = normalizeRequiredString(
    options.fullName,
    MAX_FULL_NAME_LENGTH,
  );
  const email = normalizeTenantOwnerEmail(options.email);
  const phone = normalizePhone(options.phone);

  if (
    email === null ||
    typeof options.tenantDatabaseUrl !== 'string' ||
    options.tenantDatabaseUrl.trim().length === 0 ||
    !Number.isInteger(options.connectionTimeoutMs) ||
    options.connectionTimeoutMs < 1
  ) {
    throw createOwnerError(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );
  }

  return {
    tenantDatabaseUrl: options.tenantDatabaseUrl,
    storeId,
    fullName,
    email,
    phone,
    connectionTimeoutMs: options.connectionTimeoutMs,
  };
}

function normalizeRequiredString(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') {
    throw createOwnerError(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );
  }

  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw createOwnerError(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );
  }

  return normalized;
}

function normalizePhone(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw createOwnerError(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );
  }

  const normalized = value.trim();

  if (normalized.length > MAX_PHONE_LENGTH) {
    throw createOwnerError(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );
  }

  return normalized || null;
}

function preserveOwnerError(error: unknown): TenantProvisioningError {
  return error instanceof TenantProvisioningError
    ? error
    : createOwnerError(
        TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
      );
}

function createOwnerError(
  code:
    | TenantProvisioningErrorCode.OWNER_CONFLICT
    | TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED
    | TenantProvisioningErrorCode.OWNER_CLEANUP_FAILED,
): TenantProvisioningError {
  return createTenantProvisioningError(code);
}
