import { Injectable } from '@nestjs/common';
import { Client, QueryResult } from 'pg';

import {
  createTenantProvisioningError,
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning.errors';
import {
  createTenantDatabaseIdentifiers,
  normalizeCanonicalUuid,
  quotePostgresIdentifier,
  validatePostgresIdentifier,
} from '../utils/tenant-database-identifier.util';

const ROLE_LOOKUP_SQL = `
SELECT
  role.rolname,
  role.rolcanlogin,
  role.rolsuper,
  role.rolcreatedb,
  role.rolcreaterole,
  shobj_description(role.oid, 'pg_authid') AS ownership_marker
FROM pg_roles AS role
WHERE role.rolname = $1
`;
const DATABASE_LOOKUP_SQL = `
SELECT database.datname, owner.rolname AS owner_name
FROM pg_database AS database
JOIN pg_roles AS owner ON owner.oid = database.datdba
WHERE database.datname = $1
`;
const ACQUIRE_LOCK_SQL =
  'SELECT pg_advisory_lock(hashtextextended($1, 0))';
const RELEASE_LOCK_SQL =
  'SELECT pg_advisory_unlock(hashtextextended($1, 0))';
const CREATE_ROLE_SQL = `
DO $tenant_role$
DECLARE
  tenant_role_name text := current_setting('white_label_commerce.tenant_role_name');
  tenant_role_password text := current_setting('white_label_commerce.tenant_role_password');
  tenant_role_marker text := current_setting('white_label_commerce.tenant_role_marker');
BEGIN
  EXECUTE format(
    'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
    tenant_role_name,
    tenant_role_password
  );
  EXECUTE format(
    'COMMENT ON ROLE %I IS %L',
    tenant_role_name,
    tenant_role_marker
  );
END
$tenant_role$;
`;

interface RoleRecord {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  ownership_marker: string | null;
}

interface DatabaseRecord {
  datname: string;
  owner_name: string;
}

export interface EnsureTenantInfrastructureOptions {
  postgresAdminUrl: string;
  storeId: string;
  databaseName: string;
  databaseUser: string;
  plaintextPassword: string;
  connectionTimeoutMs: number;
}

@Injectable()
export class PostgresTenantProvisionerService {
  async ensureTenantInfrastructure(
    options: EnsureTenantInfrastructureOptions,
  ): Promise<void> {
    const validated = validateOptions(options);
    const client = this.createClient(
      validated.postgresAdminUrl,
      validated.connectionTimeoutMs,
    );
    const lockValue =
      `white-label-commerce:tenant-provisioning:${validated.databaseName}`;
    let lockAcquired = false;
    let failure: TenantProvisioningError | undefined;

    try {
      try {
        await client.connect();
      } catch {
        throw createSafeError(
          TenantProvisioningErrorCode.POSTGRES_ADMIN_UNAVAILABLE,
        );
      }

      try {
        await client.query(ACQUIRE_LOCK_SQL, [lockValue]);
        lockAcquired = true;
      } catch {
        throw createSafeError(
          TenantProvisioningErrorCode.POSTGRES_ADMIN_UNAVAILABLE,
        );
      }

      await this.ensureRole(
        client,
        validated.databaseUser,
        validated.plaintextPassword,
        validated.ownershipMarker,
      );
      await this.ensureDatabase(
        client,
        validated.databaseName,
        validated.databaseUser,
      );
    } catch (error) {
      failure = preserveSafeError(
        error,
        TenantProvisioningErrorCode.POSTGRES_ADMIN_UNAVAILABLE,
      );
    } finally {
      if (lockAcquired) {
        try {
          await client.query(RELEASE_LOCK_SQL, [lockValue]);
        } catch {
          // Ending this dedicated session releases its advisory lock. Preserve
          // any primary domain error and let client termination decide whether
          // cleanup itself failed.
        }
      }

      try {
        await client.end();
      } catch {
        failure ??= createSafeError(
          TenantProvisioningErrorCode.POSTGRES_ADMIN_UNAVAILABLE,
        );
      }
    }

    if (failure) {
      throw failure;
    }
  }

  protected createClient(
    postgresAdminUrl: string,
    connectionTimeoutMs: number,
  ): Client {
    try {
      return new Client({
        connectionString: postgresAdminUrl,
        connectionTimeoutMillis: connectionTimeoutMs,
      });
    } catch {
      throw createSafeError(
        TenantProvisioningErrorCode.POSTGRES_ADMIN_UNAVAILABLE,
      );
    }
  }

  private async ensureRole(
    client: Client,
    databaseUser: string,
    plaintextPassword: string,
    ownershipMarker: string,
  ): Promise<void> {
    let role = await this.readRole(client, databaseUser);

    if (!role) {
      let transactionStarted = false;

      try {
        await client.query('BEGIN');
        transactionStarted = true;
        await client.query(
          "SELECT set_config('white_label_commerce.tenant_role_name', $1, true)",
          [databaseUser],
        );
        await client.query(
          "SELECT set_config('white_label_commerce.tenant_role_password', $1, true)",
          [plaintextPassword],
        );
        await client.query(
          "SELECT set_config('white_label_commerce.tenant_role_marker', $1, true)",
          [ownershipMarker],
        );
        await client.query(CREATE_ROLE_SQL);
        await client.query('COMMIT');
        transactionStarted = false;
      } catch {
        if (transactionStarted) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // The original stable provisioning failure remains authoritative.
          }
        }

        throw createSafeError(
          TenantProvisioningErrorCode.ROLE_PROVISIONING_FAILED,
        );
      }

      role = await this.readRole(client, databaseUser);
    }

    if (!roleMatches(role, databaseUser, ownershipMarker)) {
      throw createSafeError(TenantProvisioningErrorCode.ROLE_CONFLICT);
    }
  }

  private async readRole(
    client: Client,
    databaseUser: string,
  ): Promise<RoleRecord | undefined> {
    try {
      const result = await client.query<RoleRecord>(ROLE_LOOKUP_SQL, [
        databaseUser,
      ]);

      return result.rows[0];
    } catch {
      throw createSafeError(
        TenantProvisioningErrorCode.ROLE_PROVISIONING_FAILED,
      );
    }
  }

  private async ensureDatabase(
    client: Client,
    databaseName: string,
    databaseUser: string,
  ): Promise<void> {
    let database = await this.readDatabase(client, databaseName);

    if (!database) {
      const quotedDatabaseName = quotePostgresIdentifier(databaseName);
      const quotedDatabaseUser = quotePostgresIdentifier(databaseUser);

      try {
        await client.query(
          `CREATE DATABASE ${quotedDatabaseName} OWNER ${quotedDatabaseUser}`,
        );
      } catch {
        throw createSafeError(
          TenantProvisioningErrorCode.DATABASE_PROVISIONING_FAILED,
        );
      }

      database = await this.readDatabase(client, databaseName);
    }

    if (
      !database ||
      database.datname !== databaseName ||
      database.owner_name !== databaseUser
    ) {
      throw createSafeError(
        TenantProvisioningErrorCode.DATABASE_OWNER_CONFLICT,
      );
    }
  }

  private async readDatabase(
    client: Client,
    databaseName: string,
  ): Promise<DatabaseRecord | undefined> {
    try {
      const result: QueryResult<DatabaseRecord> =
        await client.query<DatabaseRecord>(DATABASE_LOOKUP_SQL, [databaseName]);

      return result.rows[0];
    } catch {
      throw createSafeError(
        TenantProvisioningErrorCode.DATABASE_PROVISIONING_FAILED,
      );
    }
  }
}

function validateOptions(options: EnsureTenantInfrastructureOptions): {
  postgresAdminUrl: string;
  databaseName: string;
  databaseUser: string;
  plaintextPassword: string;
  connectionTimeoutMs: number;
  ownershipMarker: string;
} {
  const storeId = normalizeCanonicalUuid(options.storeId);
  const databaseName = validatePostgresIdentifier(options.databaseName);
  const databaseUser = validatePostgresIdentifier(options.databaseUser);
  const expectedIdentifiers = createTenantDatabaseIdentifiers(storeId);

  if (
    databaseName !== expectedIdentifiers.databaseName ||
    databaseUser !== expectedIdentifiers.databaseUser
  ) {
    throw createSafeError(TenantProvisioningErrorCode.IDENTIFIER_INVALID);
  }

  if (
    typeof options.postgresAdminUrl !== 'string' ||
    options.postgresAdminUrl.trim().length === 0 ||
    typeof options.plaintextPassword !== 'string' ||
    options.plaintextPassword.length === 0 ||
    !Number.isInteger(options.connectionTimeoutMs) ||
    options.connectionTimeoutMs < 1
  ) {
    throw createSafeError(
      TenantProvisioningErrorCode.POSTGRES_ADMIN_UNAVAILABLE,
    );
  }

  return {
    postgresAdminUrl: options.postgresAdminUrl,
    databaseName,
    databaseUser,
    plaintextPassword: options.plaintextPassword,
    connectionTimeoutMs: options.connectionTimeoutMs,
    ownershipMarker: `white-label-commerce:tenant:${storeId}`,
  };
}

function roleMatches(
  role: RoleRecord | undefined,
  databaseUser: string,
  ownershipMarker: string,
): boolean {
  return Boolean(
    role &&
      role.rolname === databaseUser &&
      role.rolcanlogin === true &&
      role.rolsuper === false &&
      role.rolcreatedb === false &&
      role.rolcreaterole === false &&
      role.ownership_marker === ownershipMarker,
  );
}

function preserveSafeError(
  error: unknown,
  fallbackCode: TenantProvisioningErrorCode,
): TenantProvisioningError {
  return error instanceof TenantProvisioningError
    ? error
    : createSafeError(fallbackCode);
}

function createSafeError(
  code: TenantProvisioningErrorCode,
): TenantProvisioningError {
  return createTenantProvisioningError(code);
}
