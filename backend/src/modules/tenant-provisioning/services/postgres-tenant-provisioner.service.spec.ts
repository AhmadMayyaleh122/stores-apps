import { Client } from 'pg';

import { TenantProvisioningError } from '../tenant-provisioning.errors';
import { createTenantDatabaseIdentifiers } from '../utils/tenant-database-identifier.util';
import {
  EnsureTenantInfrastructureOptions,
  PostgresTenantProvisionerService,
} from './postgres-tenant-provisioner.service';

jest.mock('pg', () => ({ Client: jest.fn() }));

describe('PostgresTenantProvisionerService', () => {
  const storeId = '12345678-1234-4234-8123-456789012345';
  const identifiers = createTenantDatabaseIdentifiers(storeId);
  const ownershipMarker = `white-label-commerce:tenant:${storeId}`;
  const options: EnsureTenantInfrastructureOptions = {
    postgresAdminUrl:
      'postgresql://provisioner:admin-secret@localhost:5432/postgres',
    storeId,
    ...identifiers,
    plaintextPassword: 'tenant-password-secret',
    connectionTimeoutMs: 10_000,
  };
  const validRole = {
    rolname: identifiers.databaseUser,
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    ownership_marker: ownershipMarker,
  };
  const validDatabase = {
    datname: identifiers.databaseName,
    owner_name: identifiers.databaseUser,
  };
  let service: PostgresTenantProvisionerService;
  let connect: jest.Mock;
  let query: jest.Mock;
  let end: jest.Mock;

  beforeEach(() => {
    (Client as unknown as jest.Mock).mockClear();
    connect = jest.fn().mockResolvedValue(undefined);
    query = jest.fn(defaultQueryImplementation);
    end = jest.fn().mockResolvedValue(undefined);
    (Client as unknown as jest.Mock).mockImplementation(() => ({
      connect,
      query,
      end,
    }));
    service = new PostgresTenantProvisionerService();
  });

  it('uses one short-lived client with the validated connection timeout', async () => {
    await service.ensureTenantInfrastructure(options);

    expect(Client).toHaveBeenCalledTimes(1);
    expect(Client).toHaveBeenCalledWith({
      connectionString: options.postgresAdminUrl,
      connectionTimeoutMillis: options.connectionTimeoutMs,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('acquires and releases the stable session advisory lock', async () => {
    await service.ensureTenantInfrastructure(options);

    const lockValue =
      `white-label-commerce:tenant-provisioning:${identifiers.databaseName}`;
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_lock(hashtextextended($1, 0))'),
      [lockValue],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock(hashtextextended($1, 0))'),
      [lockValue],
    );
    expect(query.mock.calls.at(-1)?.[0]).toContain('pg_advisory_unlock');
  });

  it('creates a missing role and ownership comment atomically', async () => {
    let roleLookupCount = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pg_roles')) {
        roleLookupCount += 1;
        return result(roleLookupCount === 1 ? [] : [validRole]);
      }

      if (sql.includes('FROM pg_database')) {
        return result([validDatabase]);
      }

      return result([]);
    });

    await service.ensureTenantInfrastructure(options);

    const sqlCalls = query.mock.calls.map(([sql]) => sql as string);
    const beginIndex = sqlCalls.indexOf('BEGIN');
    const createIndex = sqlCalls.findIndex((sql) => sql.includes('CREATE ROLE %I'));
    const commitIndex = sqlCalls.indexOf('COMMIT');

    expect(beginIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(beginIndex);
    expect(commitIndex).toBeGreaterThan(createIndex);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('tenant_role_marker'),
      [ownershipMarker],
    );
    expect(sqlCalls[createIndex]).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE');
    expect(sqlCalls[createIndex]).toContain('COMMENT ON ROLE');
    expect(sqlCalls[createIndex]).not.toContain(options.plaintextPassword);
  });

  it('rolls back role creation failure and still releases resources', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pg_roles')) {
        return result([]);
      }

      if (sql.includes('CREATE ROLE %I')) {
        throw new Error('raw pg detail must not escape');
      }

      return result([]);
    });

    await expectCode('TENANT_ROLE_PROVISIONING_FAILED');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      expect.any(Array),
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('accepts an existing role only when all attributes and marker match', async () => {
    await expect(service.ensureTenantInfrastructure(options)).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalledWith('BEGIN');
  });

  it.each([
    { ownership_marker: null },
    { ownership_marker: 'another-application' },
    { rolcanlogin: false },
    { rolsuper: true },
    { rolcreatedb: true },
    { rolcreaterole: true },
  ])('rejects an existing conflicting role without altering it: %o', async (change) => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pg_roles')) {
        return result([{ ...validRole, ...change }]);
      }

      return result([]);
    });

    await expectCode('TENANT_ROLE_CONFLICT');
    expect(allSql()).not.toContain('ALTER ROLE');
    expect(allSql()).not.toContain('CREATE DATABASE');
    expect(allSql()).not.toContain('FROM pg_database');
    expect(allSql()).toContain('pg_advisory_unlock');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('creates a missing database outside the role transaction', async () => {
    let roleLookupCount = 0;
    let databaseLookupCount = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pg_roles')) {
        roleLookupCount += 1;
        return result(roleLookupCount === 1 ? [] : [validRole]);
      }

      if (sql.includes('FROM pg_database')) {
        databaseLookupCount += 1;
        return result(databaseLookupCount === 1 ? [] : [validDatabase]);
      }

      return result([]);
    });

    await service.ensureTenantInfrastructure(options);

    const sqlCalls = query.mock.calls.map(([sql]) => sql as string);
    const commitIndex = sqlCalls.indexOf('COMMIT');
    const createDatabaseIndex = sqlCalls.findIndex((sql) =>
      sql.startsWith('CREATE DATABASE'),
    );

    expect(createDatabaseIndex).toBeGreaterThan(commitIndex);
    expect(sqlCalls[createDatabaseIndex]).toBe(
      `CREATE DATABASE "${identifiers.databaseName}" OWNER "${identifiers.databaseUser}"`,
    );
  });

  it('accepts an existing database with the expected owner', async () => {
    await expect(service.ensureTenantInfrastructure(options)).resolves.toBeUndefined();
    expect(allSql()).not.toContain('CREATE DATABASE');
  });

  it('rejects an existing database with the wrong owner without modifying it', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pg_roles')) {
        return result([validRole]);
      }

      if (sql.includes('FROM pg_database')) {
        return result([{ ...validDatabase, owner_name: 'unexpected_owner' }]);
      }

      return result([]);
    });

    await expectCode('TENANT_DATABASE_OWNER_CONFLICT');
    expect(allSql()).not.toContain('ALTER');
    expect(allSql()).not.toContain('DROP');
    expect(allSql()).toContain('pg_advisory_unlock');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('ends the client safely when advisory lock acquisition fails', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_lock')) {
        throw new Error('lock connection detail');
      }

      return result([]);
    });

    await expectCode('POSTGRES_ADMIN_UNAVAILABLE');
    expect(allSql()).not.toContain('FROM pg_roles');
    expect(allSql()).not.toContain('FROM pg_database');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('uses successful session termination as the fallback when unlock fails', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_unlock')) {
        throw new Error('unlock pg detail');
      }

      return defaultQueryImplementation(sql);
    });

    await expect(service.ensureTenantInfrastructure(options)).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('maps client termination failure after successful provisioning safely', async () => {
    end.mockRejectedValue(new Error('client end pg topology detail'));

    try {
      await service.ensureTenantInfrastructure(options);
      throw new Error('Expected cleanup to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantProvisioningError);
      expect((error as TenantProvisioningError).code).toBe(
        'POSTGRES_ADMIN_UNAVAILABLE',
      );
      expect((error as Error).message).toBe(
        'PostgreSQL administration is unavailable.',
      );
      expect((error as Error).message).not.toContain('pg topology detail');
    }
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('preserves a primary role error when advisory unlock also fails', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pg_roles')) {
        return result([{ ...validRole, ownership_marker: null }]);
      }

      if (sql.includes('pg_advisory_unlock')) {
        throw new Error('unlock pg detail');
      }

      return result([]);
    });

    await expectCode('TENANT_ROLE_CONFLICT');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('preserves a primary database error when client termination also fails', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pg_roles')) {
        return result([validRole]);
      }

      if (sql.includes('FROM pg_database')) {
        return result([{ ...validDatabase, owner_name: 'unexpected_owner' }]);
      }

      return result([]);
    });
    end.mockRejectedValue(new Error('client end pg detail'));

    await expectCode('TENANT_DATABASE_OWNER_CONFLICT');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('maps connect failure safely, ends the client, and does not query', async () => {
    connect.mockRejectedValue(new Error('connect ECONNREFUSED secret-host'));

    await expectCode('POSTGRES_ADMIN_UNAVAILABLE');
    expect(query).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('maps database creation failure safely and releases lock and client', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pg_roles')) {
        return result([validRole]);
      }

      if (sql.includes('FROM pg_database')) {
        return result([]);
      }

      if (sql.startsWith('CREATE DATABASE')) {
        throw new Error('permission denied with pg detail');
      }

      return result([]);
    });

    await expectCode('TENANT_DATABASE_PROVISIONING_FAILED');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      expect.any(Array),
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it.each([
    { storeId: 'not-a-uuid' },
    { databaseName: 'tenant-db-invalid' },
    { databaseUser: 'tenant-user-invalid' },
    { databaseName: 'tenant_db_another_store' },
  ])('rejects invalid or non-deterministic identity before connecting: %o', async (change) => {
    await expect(
      service.ensureTenantInfrastructure({ ...options, ...change }),
    ).rejects.toBeInstanceOf(TenantProvisioningError);
    expect(Client).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('never exposes secrets, connection details, SQL, or pg detail in errors', async () => {
    query.mockRejectedValue(
      new Error('pg detail: CREATE ROLE password tenant-password-secret'),
    );

    try {
      await service.ensureTenantInfrastructure(options);
      throw new Error('Expected provisioning to fail');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).not.toContain(options.postgresAdminUrl);
      expect(message).not.toContain(options.plaintextPassword);
      expect(message).not.toContain('CREATE ROLE');
      expect(message).not.toContain('pg detail');
      expect(message).not.toContain('localhost');
      expect(message).not.toContain(identifiers.databaseName);
    }
  });

  it('keeps password and administration URL out of every SQL text value', async () => {
    let roleLookupCount = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pg_roles')) {
        roleLookupCount += 1;
        return result(roleLookupCount === 1 ? [] : [validRole]);
      }

      if (sql.includes('FROM pg_database')) {
        return result([validDatabase]);
      }

      return result([]);
    });

    await service.ensureTenantInfrastructure(options);

    const sqlTexts = query.mock.calls.map(([sql]) => sql as string);
    const parameterValues = query.mock.calls.flatMap(([, parameters]) =>
      Array.isArray(parameters) ? parameters : [],
    );

    for (const sql of sqlTexts) {
      expect(sql).not.toContain(options.plaintextPassword);
      expect(sql).not.toContain(options.postgresAdminUrl);
    }
    expect(
      parameterValues.filter((value) => value === options.plaintextPassword),
    ).toEqual([options.plaintextPassword]);
  });

  async function defaultQueryImplementation(sql: string): Promise<unknown> {
    if (sql.includes('FROM pg_roles')) {
      return result([validRole]);
    }

    if (sql.includes('FROM pg_database')) {
      return result([validDatabase]);
    }

    return result([]);
  }

  function result(rows: unknown[]): { rows: unknown[]; rowCount: number } {
    return { rows, rowCount: rows.length };
  }

  function allSql(): string {
    return query.mock.calls.map(([sql]) => sql as string).join('\n');
  }

  async function expectCode(code: string): Promise<void> {
    try {
      await service.ensureTenantInfrastructure(options);
      throw new Error('Expected provisioning to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantProvisioningError);
      expect((error as TenantProvisioningError).code).toBe(code);
    }
  }
});
