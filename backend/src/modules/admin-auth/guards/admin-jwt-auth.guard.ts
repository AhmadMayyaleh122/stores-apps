import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AdminJwtPayload } from '../admin-auth.service';
import { isCanonicalUuidV4 } from '../utils/admin-uuid.util';

interface RequestPrincipal {
  sub?: unknown;
}

interface RequestWithAdmin {
  headers: {
    authorization?: string | string[];
  };
  admin?: AdminJwtPayload;
  user?: RequestPrincipal;
}

@Injectable()
export class AdminJwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAdmin>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw this.createUnauthorizedException();
    }

    try {
      const payload = await this.jwtService.verifyAsync<AdminJwtPayload>(token, {
        secret: this.getJwtSecret(),
      });

      if (!this.isAdminJwtPayload(payload)) {
        throw this.createUnauthorizedException();
      }

      if (
        request.user &&
        (!isCanonicalUuidV4(request.user.sub) ||
          request.user.sub.toLowerCase() !== payload.sub.toLowerCase())
      ) {
        throw this.createUnauthorizedException();
      }

      request.admin = payload;
      request.user ??= payload;

      return true;
    } catch {
      throw this.createUnauthorizedException();
    }
  }

  private extractBearerToken(request: RequestWithAdmin): string | null {
    const authorization = request.headers.authorization;

    if (typeof authorization !== 'string') {
      return null;
    }

    const [scheme, token] = authorization.split(' ');

    if (scheme !== 'Bearer' || !token || authorization.split(' ').length !== 2) {
      return null;
    }

    return token;
  }

  private getJwtSecret(): string {
    const secret = this.configService.get<string>('ADMIN_JWT_SECRET');

    if (!secret) {
      throw this.createUnauthorizedException();
    }

    return secret;
  }

  private isAdminJwtPayload(payload: AdminJwtPayload): payload is AdminJwtPayload {
    return (
      isCanonicalUuidV4(payload.sub) &&
      typeof payload.email === 'string' &&
      typeof payload.role === 'string'
    );
  }

  private createUnauthorizedException(): UnauthorizedException {
    return new UnauthorizedException({
      success: false,
      message: 'Invalid or expired admin token',
    });
  }
}
