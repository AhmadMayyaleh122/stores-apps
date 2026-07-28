import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  AdminRole,
  AdminStatus,
} from '../../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AdminJwtPayload } from '../admin-auth.service';
import { ADMIN_ROLES_METADATA_KEY } from '../decorators/admin-roles.decorator';
import { isCanonicalUuidV4 } from '../utils/admin-uuid.util';

interface RequestWithAuthenticatedAdmin {
  user?: Partial<AdminJwtPayload>;
}

@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prismaService: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<AdminRole[]>(
      ADMIN_ROLES_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context
      .switchToHttp()
      .getRequest<RequestWithAuthenticatedAdmin>();
    const adminId = request.user?.sub;

    if (!isCanonicalUuidV4(adminId)) {
      throw new UnauthorizedException({
        success: false,
        message: 'Authenticated admin is required',
      });
    }

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const admin = await this.prismaService.admin.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        status: true,
        role: true,
      },
    });

    if (
      !admin ||
      admin.status !== AdminStatus.ACTIVE ||
      !requiredRoles.includes(admin.role)
    ) {
      throw new ForbiddenException({
        success: false,
        message: 'Admin is not authorized for this operation',
      });
    }

    return true;
  }
}
