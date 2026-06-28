import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { AdminJwtPayload } from '../admin-auth.service';

interface RequestWithAdmin {
  admin?: AdminJwtPayload;
}

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminJwtPayload | undefined => {
    const request = context.switchToHttp().getRequest<RequestWithAdmin>();

    return request.admin;
  },
);
