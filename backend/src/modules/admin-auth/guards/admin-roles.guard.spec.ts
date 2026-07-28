import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  AdminRole,
  AdminStatus,
} from '../../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  ADMIN_ROLES_METADATA_KEY,
  AdminRoles,
} from '../decorators/admin-roles.decorator';
import { AdminRolesGuard } from './admin-roles.guard';

describe('AdminRolesGuard', () => {
  let guard: AdminRolesGuard;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;
  let adminFindUnique: jest.Mock;
  const adminId = '12345678-1234-4234-8123-456789012345';
  const missingAdminId = '87654321-4321-4321-8123-456789012345';

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    };
    adminFindUnique = jest.fn();
    guard = new AdminRolesGuard(
      reflector as unknown as Reflector,
      {
        admin: {
          findUnique: adminFindUnique,
        },
      } as unknown as PrismaService,
    );
  });

  it('allows an authenticated request when no role metadata is present', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(
      guard.canActivate(createContext({ sub: adminId })),
    ).resolves.toBe(true);
    expect(adminFindUnique).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request when no role metadata is present', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(guard.canActivate(createContext(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(adminFindUnique).not.toHaveBeenCalled();
  });

  it('supports @AdminRoles(AdminRole.SUPER_ADMIN)', () => {
    class TestController {
      @AdminRoles(AdminRole.SUPER_ADMIN)
      provision(): void {}
    }

    expect(
      Reflect.getMetadata(
        ADMIN_ROLES_METADATA_KEY,
        TestController.prototype.provision,
      ),
    ).toEqual([AdminRole.SUPER_ADMIN]);
  });

  it('rejects a request with no authenticated user', async () => {
    requireSuperAdmin();

    await expect(guard.canActivate(createContext(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a request with no authenticated user sub', async () => {
    requireSuperAdmin();

    await expect(guard.canActivate(createContext({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('does not use request.admin as a fallback when request.user is missing', async () => {
    requireSuperAdmin();

    await expect(
      guard.canActivate(
        createContext(undefined, {
          sub: adminId,
          role: AdminRole.SUPER_ADMIN,
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(adminFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '   ',
    'not-a-uuid',
    '12345678-1234-1234-8123-456789012345',
  ])('rejects malformed authenticated admin sub %s without querying Prisma', async (sub) => {
    requireSuperAdmin();

    await expect(guard.canActivate(createContext({ sub }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(adminFindUnique).not.toHaveBeenCalled();
  });

  it('rejects an authenticated admin that no longer exists', async () => {
    requireSuperAdmin();
    adminFindUnique.mockResolvedValue(null);

    await expect(
      guard.canActivate(createContext({ sub: missingAdminId })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an inactive admin', async () => {
    requireSuperAdmin();
    adminFindUnique.mockResolvedValue({
      id: adminId,
      status: AdminStatus.INACTIVE,
      role: AdminRole.SUPER_ADMIN,
    });

    await expect(
      guard.canActivate(createContext({ sub: adminId })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([AdminRole.ADMIN, AdminRole.SUPPORT])(
    'rejects current database role %s when SUPER_ADMIN is required',
    async (role) => {
      requireSuperAdmin();
      adminFindUnique.mockResolvedValue({
        id: adminId,
        status: AdminStatus.ACTIVE,
        role,
      });

      await expect(
        guard.canActivate(createContext({ sub: adminId, role })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('accepts a current SUPER_ADMIN', async () => {
    requireSuperAdmin();
    adminFindUnique.mockResolvedValue({
      id: adminId,
      status: AdminStatus.ACTIVE,
      role: AdminRole.SUPER_ADMIN,
    });

    await expect(
      guard.canActivate(
        createContext({ sub: adminId, role: AdminRole.SUPER_ADMIN }),
      ),
    ).resolves.toBe(true);
    expect(adminFindUnique).toHaveBeenCalledWith({
      where: { id: adminId },
      select: {
        id: true,
        status: true,
        role: true,
      },
    });
  });

  it('rejects a stale JWT claiming SUPER_ADMIN when the database role is ADMIN', async () => {
    requireSuperAdmin();
    adminFindUnique.mockResolvedValue({
      id: adminId,
      status: AdminStatus.ACTIVE,
      role: AdminRole.ADMIN,
    });

    await expect(
      guard.canActivate(
        createContext({ sub: adminId, role: AdminRole.SUPER_ADMIN }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts a stale JWT claiming ADMIN when the database role is SUPER_ADMIN', async () => {
    requireSuperAdmin();
    adminFindUnique.mockResolvedValue({
      id: adminId,
      status: AdminStatus.ACTIVE,
      role: AdminRole.SUPER_ADMIN,
    });

    await expect(
      guard.canActivate(
        createContext({ sub: adminId, role: AdminRole.ADMIN }),
      ),
    ).resolves.toBe(true);
  });

  function requireSuperAdmin(): void {
    reflector.getAllAndOverride.mockReturnValue([AdminRole.SUPER_ADMIN]);
  }

  function createContext(
    user:
      | {
          sub?: string;
          role?: AdminRole;
      }
      | undefined,
    admin?: {
      sub: string;
      role: AdminRole;
    },
  ): ExecutionContext {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user, admin }),
      }),
    } as unknown as ExecutionContext;
  }
});
