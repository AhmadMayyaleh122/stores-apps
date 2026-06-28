import { Body, Controller, Post } from '@nestjs/common';

import { AdminAuthService, AdminLoginResponse } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  async login(@Body() loginDto: AdminLoginDto): Promise<AdminLoginResponse> {
    return this.adminAuthService.login(loginDto);
  }
}
