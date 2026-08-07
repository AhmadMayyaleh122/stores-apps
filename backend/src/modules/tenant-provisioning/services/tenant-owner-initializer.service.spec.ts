import { PrismaPg } from '@prisma/adapter-pg';

import {
  EmployeeStatus,
  PrismaClient as TenantPrismaClient,
} from '../../../../generated/tenant-prisma/client';
import {
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning.errors';
import {
  InitializeTenantOwnerOptions,
  TenantOwnerInitializerService,
} from './tenant-owner-initializer.service';

jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: jest.fn() }));
jest.mock('../../../../generated/tenant-prisma/client', () => ({
  EmployeeStatus: {
    PENDING_ACTIVATION: 'PENDING_ACTIVATION',
    ACTIVE: 'ACTIVE',
    INACTIVE: 'INACTIVE',
    SUSPENDED: 'SUSPENDED',
  },
  PrismaClient: jest.fn(),
}));

describe('TenantOwnerInitializerService', () => {
  const storeId = '12345678-1234-4234-8123-456789012345';
  const otherStoreId = '87654321-4321-4321-8123-456789012345';
  const roleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tenantDatabaseUrl =
    'postgresql://tenant:tenant-secret@localhost/tenant_database';
  const matchingIdentity = { id: 1, masterStoreId: storeId };
  const matchingRole = {
    id: roleId,
    key: 'OWNER',
    name: 'Owner',
    isSystem: true,
  };
  const matchingOwner = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    fullName: 'Demo Owner',
    email: 'owner@example.com',
    phone: '+970599000000',
    roleId,
    status: EmployeeStatus.PENDING_ACTIVATION,
    isStoreOwner: true,
    masterStoreId: storeId,
  };

  let service: TenantOwnerInitializerService;
  let transaction: jest.Mock;
  let disconnect: jest.Mock;
  let identityFindUnique: jest.Mock;
  let roleFindUnique: jest.Mock;
  let roleCreate: jest.Mock;
  let employeeFindUnique: jest.Mock;
  let employeeFindFirst: jest.Mock;
  let employeeCreate: jest.Mock;
  let transactionClient: {
    tenantIdentity: { findUnique: jest.Mock };
    role: { findUnique: jest.Mock; create: jest.Mock };
    employee: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
    };
  };

  beforeEach(() => {
    (PrismaPg as unknown as jest.Mock).mockReset();
    (TenantPrismaClient as unknown as jest.Mock).mockReset();
    identityFindUnique = jest.fn().mockResolvedValue(matchingIdentity);
    roleFindUnique = jest.fn().mockResolvedValue(matchingRole);
    roleCreate = jest.fn().mockImplementation(({ data }) =>
      Promise.resolve({
        id: roleId,
        ...data,
      }),
    );
    employeeFindUnique = jest
      .fn()
      .mockImplementation(({ where }) =>
        Promise.resolve('masterStoreId' in where ? matchingOwner : null),
      );
    employeeFindFirst = jest.fn().mockResolvedValue(null);
    employeeCreate = jest.fn().mockImplementation(({ data }) =>
      Promise.resolve({
        id: matchingOwner.id,
        ...data,
      }),
    );
    transactionClient = {
      tenantIdentity: { findUnique: identityFindUnique },
      role: { findUnique: roleFindUnique, create: roleCreate },
      employee: {
        findUnique: employeeFindUnique,
        findFirst: employeeFindFirst,
        create: employeeCreate,
      },
    };
    transaction = jest
      .fn()
      .mockImplementation((callback) => callback(transactionClient));
    disconnect = jest.fn().mockResolvedValue(undefined);
    (PrismaPg as unknown as jest.Mock).mockReturnValue({ adapter: true });
    (TenantPrismaClient as unknown as jest.Mock).mockReturnValue({
      $transaction: transaction,
      $disconnect: disconnect,
    });
    service = new TenantOwnerInitializerService();
  });

  it('uses a bounded, single-connection tenant client and always disconnects', async () => {
    await service.initialize(validOptions());

    expect(PrismaPg).toHaveBeenCalledWith({
      connectionString: tenantDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
    expect(TenantPrismaClient).toHaveBeenCalledWith({
      adapter: { adapter: true },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('normalizes name, email, and phone before creating the owner', async () => {
    configureMissingRoleAndOwner();

    await service.initialize(
      validOptions({
        fullName: '  Demo Owner  ',
        email: '  OWNER@EXAMPLE.COM  ',
        phone: '  +970599000000  ',
      }),
    );

    expect(employeeCreate).toHaveBeenCalledWith({
      data: {
        fullName: 'Demo Owner',
        email: 'owner@example.com',
        phone: '+970599000000',
        roleId,
        status: EmployeeStatus.PENDING_ACTIVATION,
        isStoreOwner: true,
        masterStoreId: storeId,
      },
      select: expectedEmployeeSelect(),
    });
  });

  it.each([undefined, null, '', '   '])(
    'normalizes phone value %p to null',
    async (phone) => {
      configureMissingRoleAndOwner();

      await service.initialize(validOptions({ phone }));

      expect(employeeCreate.mock.calls[0][0].data.phone).toBeNull();
    },
  );

  it.each([
    {
      label: 'empty name',
      options: { fullName: '   ' },
      code: TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    },
    {
      label: 'invalid email',
      options: { email: 'not-an-email' },
      code: TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    },
    {
      label: 'overlong name',
      options: { fullName: 'a'.repeat(121) },
      code: TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    },
    {
      label: 'overlong email',
      options: { email: `${'a'.repeat(244)}@example.com` },
      code: TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    },
    {
      label: 'overlong phone',
      options: { phone: '1'.repeat(41) },
      code: TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    },
    {
      label: 'zero timeout',
      options: { connectionTimeoutMs: 0 },
      code: TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    },
    {
      label: 'fractional timeout',
      options: { connectionTimeoutMs: 1.5 },
      code: TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    },
    {
      label: 'empty database URL',
      options: { tenantDatabaseUrl: '  ' },
      code: TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    },
    {
      label: 'invalid UUID',
      options: { storeId: 'not-a-uuid' },
      code: TenantProvisioningErrorCode.IDENTIFIER_INVALID,
    },
  ])('rejects $label before constructing a client', async ({ options, code }) => {
    await expectCode(code, validOptions(options));
    expect(PrismaPg).not.toHaveBeenCalled();
    expect(TenantPrismaClient).not.toHaveBeenCalled();
  });

  it('checks TenantIdentity first and creates the canonical OWNER role and owner', async () => {
    configureMissingRoleAndOwner();

    await service.initialize(validOptions());

    expect(identityFindUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true, masterStoreId: true },
    });
    expect(identityFindUnique.mock.invocationCallOrder[0]).toBeLessThan(
      roleFindUnique.mock.invocationCallOrder[0],
    );
    expect(roleCreate).toHaveBeenCalledWith({
      data: { key: 'OWNER', name: 'Owner', isSystem: true },
      select: {
        id: true,
        key: true,
        name: true,
        isSystem: true,
      },
    });
    expect(employeeCreate.mock.calls[0][0].data).toEqual({
      fullName: 'Demo Owner',
      email: 'owner@example.com',
      phone: '+970599000000',
      roleId,
      status: EmployeeStatus.PENDING_ACTIVATION,
      isStoreOwner: true,
      masterStoreId: storeId,
    });
    expect(Object.keys(employeeCreate.mock.calls[0][0].data)).not.toEqual(
      expect.arrayContaining([
        'password',
        'passwordHash',
        'invitationToken',
        'refreshToken',
      ]),
    );
  });

  it('accepts an exact existing OWNER role and owner without writing', async () => {
    await expect(service.initialize(validOptions())).resolves.toBeUndefined();

    expect(roleCreate).not.toHaveBeenCalled();
    expect(employeeCreate).not.toHaveBeenCalled();
    expect(employeeFindFirst).not.toHaveBeenCalled();
  });

  it('is idempotent across repeated initialization calls', async () => {
    await service.initialize(validOptions());
    await service.initialize(validOptions());

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(roleCreate).not.toHaveBeenCalled();
    expect(employeeCreate).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['full name', { fullName: 'Different Owner' }],
    ['email', { email: 'different@example.com' }],
    ['phone', { phone: '+970599111111' }],
    ['role', { roleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
    ['status', { status: EmployeeStatus.ACTIVE }],
    ['owner marker', { isStoreOwner: false }],
  ])('rejects an existing owner with a mismatched %s', async (_label, change) => {
    employeeFindUnique.mockResolvedValue({ ...matchingOwner, ...change });

    await expectCode(TenantProvisioningErrorCode.OWNER_CONFLICT);
    expect(employeeCreate).not.toHaveBeenCalled();
  });

  it('rejects a designated owner associated with another store', async () => {
    employeeFindUnique.mockResolvedValueOnce(null);
    employeeFindFirst.mockResolvedValue({
      ...matchingOwner,
      masterStoreId: otherStoreId,
    });

    await expectCode(TenantProvisioningErrorCode.OWNER_CONFLICT);
    expect(employeeCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['name', { name: 'Store owner' }],
    ['system marker', { isSystem: false }],
  ])('rejects an OWNER role with incompatible %s', async (_label, change) => {
    roleFindUnique.mockResolvedValue({ ...matchingRole, ...change });

    await expectCode(TenantProvisioningErrorCode.OWNER_CONFLICT);
    expect(employeeFindUnique).not.toHaveBeenCalled();
    expect(roleCreate).not.toHaveBeenCalled();
  });

  it('rejects an email that belongs to another employee', async () => {
    employeeFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...matchingOwner,
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        isStoreOwner: false,
        masterStoreId: null,
      });
    employeeFindFirst.mockResolvedValue(null);

    await expectCode(TenantProvisioningErrorCode.OWNER_CONFLICT);
    expect(employeeCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['mismatched', { id: 1, masterStoreId: otherStoreId }],
  ])('rejects a %s TenantIdentity before resolving the OWNER role', async (_label, identity) => {
    identityFindUnique.mockResolvedValue(identity);

    await expectCode(TenantProvisioningErrorCode.IDENTITY_MISMATCH);
    expect(roleFindUnique).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('accepts a matching OWNER role created by a unique-race winner', async () => {
    roleFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(matchingRole);
    roleCreate.mockRejectedValue(uniqueViolation(['key']));

    await expect(service.initialize(validOptions())).resolves.toBeUndefined();

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(identityFindUnique).toHaveBeenCalledTimes(2);
  });

  it('rejects a conflicting OWNER role created by a unique-race winner', async () => {
    roleFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...matchingRole, name: 'Conflicting Owner' });
    roleCreate.mockRejectedValue(uniqueViolation(['key']));

    await expectCode(TenantProvisioningErrorCode.OWNER_CONFLICT);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('re-reads and accepts the final matching state after repeated role races', async () => {
    roleFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(matchingRole);
    roleCreate.mockRejectedValue(uniqueViolation(['key']));

    await expect(service.initialize(validOptions())).resolves.toBeUndefined();

    expect(transaction).toHaveBeenCalledTimes(4);
    expect(identityFindUnique).toHaveBeenCalledTimes(4);
    expect(employeeFindUnique).toHaveBeenCalledTimes(1);
  });

  it('accepts a matching owner created by a unique-race winner', async () => {
    employeeFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(matchingOwner);
    employeeFindFirst.mockResolvedValue(null);
    employeeCreate.mockRejectedValue(uniqueViolation(['email']));

    await expect(service.initialize(validOptions())).resolves.toBeUndefined();

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(identityFindUnique).toHaveBeenCalledTimes(2);
  });

  it('rejects a conflicting owner created by a unique-race winner', async () => {
    employeeFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...matchingOwner,
        email: 'conflict@example.com',
      });
    employeeFindFirst.mockResolvedValue(null);
    employeeCreate.mockRejectedValue(
      uniqueViolation(['master_store_id']),
    );

    await expectCode(TenantProvisioningErrorCode.OWNER_CONFLICT);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unrelated P2002 as an idempotent race', async () => {
    roleFindUnique.mockResolvedValue(null);
    roleCreate.mockRejectedValue(uniqueViolation(['id']));

    await expectCode(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('sanitizes a non-unique employee creation failure', async () => {
    employeeFindUnique.mockResolvedValue(null);
    employeeFindFirst.mockResolvedValue(null);
    employeeCreate.mockRejectedValue(
      new Error('raw employee INSERT and constraint detail'),
    );

    const error = await expectCode(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );

    expect(error.message).toBe('Tenant store owner could not be initialized.');
    expect(error.message).not.toContain('INSERT');
  });

  it('sanitizes a query failure and still disconnects', async () => {
    identityFindUnique.mockRejectedValue(
      new Error(
        `SELECT Demo Owner, owner@example.com, +970599000000 using ${tenantDatabaseUrl}`,
      ),
    );

    const error = await expectCode(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );

    expect(error.message).toBe('Tenant store owner could not be initialized.');
    expect(JSON.stringify(error)).not.toContain('owner@example.com');
    expect(error.message).not.toContain('Demo Owner');
    expect(error.message).not.toContain('+970599000000');
    expect(error.message).not.toContain(tenantDatabaseUrl);
    expect(error.message).not.toContain('tenant_database');
    expect(error.message).not.toContain('tenant-secret');
    expect(error.message).not.toContain('SELECT');
    expect(error.message).not.toContain(storeId);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('sanitizes a transaction failure and disconnects', async () => {
    transaction.mockRejectedValue(
      new Error('PostgreSQL topology and raw Prisma transaction detail'),
    );

    const error = await expectCode(
      TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
    );

    expect(error.message).toBe('Tenant store owner could not be initialized.');
    expect(error.message).not.toContain('PostgreSQL');
    expect(error.message).not.toContain('Prisma');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('returns a safe cleanup error when successful initialization cannot disconnect', async () => {
    disconnect.mockRejectedValue(
      new Error(`disconnect failed for ${tenantDatabaseUrl}`),
    );

    const error = await expectCode(
      TenantProvisioningErrorCode.OWNER_CLEANUP_FAILED,
    );

    expect(error.message).toBe(
      'Tenant store owner connection could not be closed.',
    );
    expect(error.message).not.toContain(tenantDatabaseUrl);
    expect(error.message).not.toContain('tenant-secret');
  });

  it('preserves the primary conflict when disconnect also fails', async () => {
    employeeFindUnique.mockResolvedValue({
      ...matchingOwner,
      fullName: 'Conflicting Owner',
    });
    disconnect.mockRejectedValue(new Error('raw cleanup failure'));

    await expectCode(TenantProvisioningErrorCode.OWNER_CONFLICT);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(['adapter', 'client'] as const)(
    'sanitizes %s construction failure without disconnecting an absent client',
    async (failurePoint) => {
      if (failurePoint === 'adapter') {
        (PrismaPg as unknown as jest.Mock).mockImplementationOnce(() => {
          throw new Error('adapter URL and topology detail');
        });
      } else {
        (TenantPrismaClient as unknown as jest.Mock).mockImplementationOnce(
          () => {
            throw new Error('Prisma client construction detail');
          },
        );
      }

      const error = await expectCode(
        TenantProvisioningErrorCode.OWNER_INITIALIZATION_FAILED,
      );

      expect(error.message).toBe('Tenant store owner could not be initialized.');
      expect(disconnect).not.toHaveBeenCalled();
    },
  );

  function configureMissingRoleAndOwner(): void {
    roleFindUnique.mockResolvedValue(null);
    employeeFindUnique.mockResolvedValue(null);
    employeeFindFirst.mockResolvedValue(null);
  }

  function validOptions(
    overrides: Partial<InitializeTenantOwnerOptions> = {},
  ): InitializeTenantOwnerOptions {
    return {
      tenantDatabaseUrl,
      storeId,
      fullName: matchingOwner.fullName,
      email: matchingOwner.email,
      phone: matchingOwner.phone,
      connectionTimeoutMs: 10_000,
      ...overrides,
    };
  }

  async function expectCode(
    code: TenantProvisioningErrorCode,
    options = validOptions(),
  ): Promise<TenantProvisioningError> {
    try {
      await service.initialize(options);
      throw new Error('Expected tenant owner initialization to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantProvisioningError);
      expect((error as TenantProvisioningError).code).toBe(code);
      return error as TenantProvisioningError;
    }
  }

  function uniqueViolation(target: string[]): {
    code: string;
    meta: { target: string[] };
    message: string;
  } {
    return {
      code: 'P2002',
      meta: { target },
      message: `raw unique detail for ${tenantDatabaseUrl}`,
    };
  }

  function expectedEmployeeSelect(): Record<string, true> {
    return {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      roleId: true,
      status: true,
      isStoreOwner: true,
      masterStoreId: true,
    };
  }
});
