import { SetMetadata } from '@nestjs/common';

import { AdminRole } from '../../../../generated/prisma/client';

export const ADMIN_ROLES_METADATA_KEY = 'admin_roles';

export const AdminRoles = (...roles: AdminRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ADMIN_ROLES_METADATA_KEY, roles);
