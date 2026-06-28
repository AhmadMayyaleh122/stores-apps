import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import {
  AdminAuthService,
  AdminJwtPayload,
  AdminLoginResponse,
  CurrentAdminResponse,
} from './admin-auth.service';
import { CurrentAdmin } from './decorators/current-admin.decorator';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminJwtAuthGuard } from './guards/admin-jwt-auth.guard';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  async login(@Body() loginDto: AdminLoginDto): Promise<AdminLoginResponse> {
    return this.adminAuthService.login(loginDto);
  }

  @Get('me')
  @UseGuards(AdminJwtAuthGuard)
  async getCurrentAdmin(
    @CurrentAdmin() admin: AdminJwtPayload,
  ): Promise<CurrentAdminResponse> {
    return this.adminAuthService.getCurrentAdmin(admin);
  }
}
