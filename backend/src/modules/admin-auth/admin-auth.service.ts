import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JwtSignOptions } from '@nestjs/jwt';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';

import { AdminRole, AdminStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AdminLoginDto } from './dto/admin-login.dto';

export interface AdminLoginResponse {
  success: true;
  message: string;
  data: {
    id: string;
    fullName: string;
    email: string;
    role: AdminRole;
    accessToken: string;
  };
}

interface AdminJwtPayload {
  sub: string;
  email: string;
  role: AdminRole;
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async login(loginDto: AdminLoginDto): Promise<AdminLoginResponse> {
    const email = loginDto.email.trim().toLowerCase();
    const admin = await this.prismaService.admin.findUnique({
      where: { email },
      select: {
        id: true,
        fullName: true,
        email: true,
        passwordHash: true,
        role: true,
        status: true,
      },
    });

    if (!admin) {
      throw new UnauthorizedException({
        success: false,
        message: 'Invalid admin credentials',
      });
    }

    if (admin.status !== AdminStatus.ACTIVE) {
      throw new ForbiddenException({
        success: false,
        message: 'Admin account is not active',
      });
    }

    const isPasswordValid = await this.verifyPassword(
      admin.passwordHash,
      loginDto.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException({
        success: false,
        message: 'Invalid admin credentials',
      });
    }

    const accessToken = await this.jwtService.signAsync(
      {
        sub: admin.id,
        email: admin.email,
        role: admin.role,
      } satisfies AdminJwtPayload,
      {
        secret: this.getJwtSecret(),
        expiresIn: this.getJwtExpiresIn(),
      },
    );

    return {
      success: true,
      message: 'Admin login successful',
      data: {
        id: admin.id,
        fullName: admin.fullName,
        email: admin.email,
        role: admin.role,
        accessToken,
      },
    };
  }

  private async verifyPassword(
    passwordHash: string,
    password: string,
  ): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  private getJwtSecret(): string {
    const secret = this.configService.get<string>('ADMIN_JWT_SECRET');

    if (!secret) {
      throw new InternalServerErrorException({
        success: false,
        message: 'Admin JWT secret is not configured',
      });
    }

    return secret;
  }

  private getJwtExpiresIn(): JwtSignOptions['expiresIn'] {
    return (
      this.configService.get<string>('ADMIN_JWT_EXPIRES_IN') ?? '1h'
    ) as JwtSignOptions['expiresIn'];
  }
}
