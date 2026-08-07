import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import {
  AdminRole,
  AdminStatus,
} from '../../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AdminJwtPayload } from '../admin-auth.service';
import { AdminJwtAuthGuard } from './admin-jwt-auth.guard';
import { AdminRolesGuard } from './admin-roles.guard';

describe('AdminJwtAuthGuard', () => {
  const adminId = 'a2345678-1234-4234-8123-456789012345';
  const otherAdminId = '87654321-4321-4321-8123-456789012345';
  const payload: AdminJwtPayload = {
    sub: adminId,
    email: 'admin@example.com',
    role: AdminRole.ADMIN,
  };
  let jwtService: jest.Mocked<Pick<JwtService, 'verifyAsync'>>;
  let guard: AdminJwtAuthGuard;

  beforeEach(() => {
    jwtService = {
      verifyAsync: jest.fn().mockResolvedValue(payload),
    };
    guard = new AdminJwtAuthGuard(
      jwtService as unknown as JwtService,
      {
        get: jest.fn().mockReturnValue('test-jwt-secret'),
      } as unknown as ConfigService,
    );
  });

  it('assigns the validated payload to request.admin and an absent request.user', async () => {
    const request = createRequest();

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.admin).toBe(payload);
    expect(request.user).toBe(payload);
  });

  it('preserves a matching Passport-style request.user object', async () => {
    const existingUser = {
      sub: adminId,
      passportPrincipal: true,
    };
    const request = createRequest(existingUser);

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.admin).toBe(payload);
    expect(request.user).toBe(existingUser);
  });

  it('preserves an existing user with the same UUID in different casing', async () => {
    const existingUser = {
      sub: adminId.toUpperCase(),
      passportPrincipal: true,
    };
    const request = createRequest(existingUser);

    expect(existingUser.sub).not.toBe(adminId);
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.admin).toBe(payload);
    expect(request.user).toBe(existingUser);
  });

  it('rejects a conflicting existing request.user without assigning request.admin', async () => {
    const existingUser = { sub: otherAdminId };
    const request = createRequest(existingUser);

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.admin).toBeUndefined();
    expect(request.user).toBe(existingUser);
  });

  it('rejects a non-string existing request.user sub', async () => {
    const existingUser = { sub: 12345 };
    const request = createRequest(existingUser);

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.admin).toBeUndefined();
    expect(request.user).toBe(existingUser);
  });

  it.each([
    '',
    '   ',
    'not-a-uuid',
    '12345678-1234-1234-8123-456789012345',
  ])('rejects malformed JWT sub %s before assigning request properties', async (sub) => {
    jwtService.verifyAsync.mockResolvedValue({ ...payload, sub });
    const request = createRequest();

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.admin).toBeUndefined();
    expect(request.user).toBeUndefined();
  });

  it('supports sequential JWT and database-backed role guard execution', async () => {
    const request = createRequest();
    const context = createContext(request);
    const adminFindUnique = jest.fn().mockResolvedValue({
      id: adminId,
      status: AdminStatus.ACTIVE,
      role: AdminRole.SUPER_ADMIN,
    });
    const rolesGuard = new AdminRolesGuard(
      {
        getAllAndOverride: jest.fn().mockReturnValue([AdminRole.SUPER_ADMIN]),
      } as unknown as Reflector,
      {
        admin: {
          findUnique: adminFindUnique,
        },
      } as unknown as PrismaService,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(rolesGuard.canActivate(context)).resolves.toBe(true);
    expect(adminFindUnique).toHaveBeenCalledWith({
      where: { id: adminId },
      select: {
        id: true,
        status: true,
        role: true,
      },
    });
  });

  function createRequest(user?: { sub?: unknown; [key: string]: unknown }): {
    headers: { authorization: string };
    admin?: AdminJwtPayload;
    user?: { sub?: unknown; [key: string]: unknown } | AdminJwtPayload;
  } {
    return {
      headers: {
        authorization: 'Bearer test-token',
      },
      ...(user ? { user } : {}),
    };
  }

  function createContext(request: ReturnType<typeof createRequest>): ExecutionContext {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }
});
