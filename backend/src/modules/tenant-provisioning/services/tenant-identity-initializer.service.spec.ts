import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient as TenantPrismaClient } from '../../../../generated/tenant-prisma/client';
import { TenantProvisioningError } from '../tenant-provisioning.errors';
import { TenantIdentityInitializerService } from './tenant-identity-initializer.service';

jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: jest.fn() }));
jest.mock('../../../../generated/tenant-prisma/client', () => ({
  PrismaClient: jest.fn(),
}));

describe('TenantIdentityInitializerService', () => {
  const storeId = '12345678-1234-4234-8123-456789012345';
  const otherStoreId = '87654321-4321-4321-8123-456789012345';
  const tenantDatabaseUrl =
    'postgresql://tenant:tenant-secret@localhost/tenant_database';
  const matchingIdentity = { id: 1, masterStoreId: storeId };
  let service: TenantIdentityInitializerService;
  let findUnique: jest.Mock;
  let create: jest.Mock;
  let disconnect: jest.Mock;

  beforeEach(() => {
    (PrismaPg as unknown as jest.Mock).mockReset();
    (TenantPrismaClient as unknown as jest.Mock).mockReset();
    findUnique = jest.fn();
    create = jest.fn().mockResolvedValue(matchingIdentity);
    disconnect = jest.fn().mockResolvedValue(undefined);
    (PrismaPg as unknown as jest.Mock).mockReturnValue({ adapter: true });
    (TenantPrismaClient as unknown as jest.Mock).mockReturnValue({
      tenantIdentity: { findUnique, create },
      $disconnect: disconnect,
    });
    service = new TenantIdentityInitializerService();
  });

  it('uses a short-lived tenant Prisma client with a single-connection adapter', async () => {
    findUnique.mockResolvedValue(matchingIdentity);

    await service.initializeAndVerify(validOptions());

    expect(PrismaPg).toHaveBeenCalledWith({
      connectionString: tenantDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: 10_000,
    });
    expect(TenantPrismaClient).toHaveBeenCalledWith({
      adapter: { adapter: true },
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('accepts an existing matching singleton and verifies it again', async () => {
    findUnique.mockResolvedValueOnce(matchingIdentity).mockResolvedValueOnce(
      matchingIdentity,
    );

    await expect(service.initializeAndVerify(validOptions())).resolves.toBeUndefined();
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an existing mismatched identity without overwriting it', async () => {
    findUnique.mockResolvedValue({ id: 1, masterStoreId: otherStoreId });

    await expectCode('TENANT_IDENTITY_MISMATCH');
    expect(create).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('creates the exact singleton identity when it is missing', async () => {
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(matchingIdentity);

    await service.initializeAndVerify(validOptions());

    expect(create).toHaveBeenCalledWith({
      data: { id: 1, masterStoreId: storeId },
      select: { id: true, masterStoreId: true },
    });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('handles a create race by re-reading and accepting a matching identity', async () => {
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(matchingIdentity)
      .mockResolvedValueOnce(matchingIdentity);
    create.mockRejectedValue({ code: 'P2002', detail: 'secret detail' });

    await expect(service.initializeAndVerify(validOptions())).resolves.toBeUndefined();
    expect(findUnique).toHaveBeenCalledTimes(3);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a create race reveals a mismatched identity', async () => {
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 1, masterStoreId: otherStoreId });
    create.mockRejectedValue({ code: 'P2002' });

    await expectCode('TENANT_IDENTITY_MISMATCH');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    { id: 2, masterStoreId: storeId },
    { id: 1, masterStoreId: otherStoreId },
  ])('fails final verification for invalid final identity %o', async (finalIdentity) => {
    findUnique
      .mockResolvedValueOnce(matchingIdentity)
      .mockResolvedValueOnce(finalIdentity);

    await expectCode('TENANT_VERIFICATION_FAILED');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('maps an initial Prisma query failure safely and disconnects', async () => {
    findUnique.mockRejectedValue(
      new Error('Prisma query failed with tenant-secret and topology'),
    );

    await expectCode('TENANT_IDENTITY_INITIALIZATION_FAILED');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('maps a final verification query failure safely and disconnects', async () => {
    findUnique
      .mockResolvedValueOnce(matchingIdentity)
      .mockRejectedValueOnce(new Error('Prisma final read detail'));

    await expectCode('TENANT_VERIFICATION_FAILED');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('maps disconnect failure after successful verification to a safe cleanup error', async () => {
    findUnique.mockResolvedValue(matchingIdentity);
    disconnect.mockRejectedValue(
      new Error(`adapter detail at ${tenantDatabaseUrl}`),
    );

    try {
      await service.initializeAndVerify(validOptions());
      throw new Error('Expected cleanup to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantProvisioningError);
      expect((error as TenantProvisioningError).code).toBe(
        'TENANT_IDENTITY_CLEANUP_FAILED',
      );
      expect((error as Error).message).toBe(
        'Tenant database identity connection could not be closed.',
      );
      expect((error as Error).message).not.toContain(tenantDatabaseUrl);
      expect((error as Error).message).not.toContain('adapter detail');
    }
  });

  it.each([
    {
      primaryCode: 'TENANT_IDENTITY_MISMATCH',
      configure: () =>
        findUnique.mockResolvedValue({ id: 1, masterStoreId: otherStoreId }),
    },
    {
      primaryCode: 'TENANT_IDENTITY_INITIALIZATION_FAILED',
      configure: () =>
        findUnique.mockRejectedValue(new Error('primary Prisma query detail')),
    },
  ])(
    'preserves $primaryCode when disconnect also fails',
    async ({ primaryCode, configure }) => {
      configure();
      disconnect.mockRejectedValue(new Error('disconnect Prisma detail'));

      await expectCode(primaryCode);
      expect(disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['adapter', 'client'] as const)(
    'does not disconnect an unconstructed client after %s construction failure',
    async (failurePoint) => {
      if (failurePoint === 'adapter') {
        (PrismaPg as unknown as jest.Mock).mockImplementationOnce(() => {
          throw new Error('adapter construction detail');
        });
      } else {
        (TenantPrismaClient as unknown as jest.Mock).mockImplementationOnce(
          () => {
            throw new Error('client construction detail');
          },
        );
      }

      await expectCode('TENANT_IDENTITY_INITIALIZATION_FAILED');
      expect(disconnect).not.toHaveBeenCalled();
      if (failurePoint === 'adapter') {
        expect(TenantPrismaClient).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects an invalid store ID before creating a client', async () => {
    await expect(
      service.initializeAndVerify({ ...validOptions(), storeId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(TenantProvisioningError);
    expect(PrismaPg).not.toHaveBeenCalled();
    expect(TenantPrismaClient).not.toHaveBeenCalled();
  });

  it('uses safe messages without URL, Prisma detail, SQL, or topology', async () => {
    findUnique.mockRejectedValue(
      new Error(`SELECT secret FROM topology at ${tenantDatabaseUrl}`),
    );

    try {
      await service.initializeAndVerify(validOptions());
      throw new Error('Expected initialization to fail');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toBe('Tenant database identity could not be initialized.');
      expect(message).not.toContain(tenantDatabaseUrl);
      expect(message).not.toContain('tenant-secret');
      expect(message).not.toContain('SELECT');
      expect(message).not.toContain('topology');
      expect(message).not.toContain(storeId);
    }
  });

  it('never imports or constructs the master Prisma client', async () => {
    findUnique.mockResolvedValue(matchingIdentity);

    await service.initializeAndVerify(validOptions());

    expect(TenantPrismaClient).toHaveBeenCalledTimes(1);
    expect(PrismaPg).toHaveBeenCalledTimes(1);
  });

  function validOptions(): {
    tenantDatabaseUrl: string;
    storeId: string;
    connectionTimeoutMs: number;
  } {
    return {
      tenantDatabaseUrl,
      storeId,
      connectionTimeoutMs: 10_000,
    };
  }

  async function expectCode(code: string): Promise<void> {
    try {
      await service.initializeAndVerify(validOptions());
      throw new Error('Expected identity initialization to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantProvisioningError);
      expect((error as TenantProvisioningError).code).toBe(code);
    }
  }
});
