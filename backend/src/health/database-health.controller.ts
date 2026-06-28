import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

export interface DatabaseHealthResponse {
  success: true;
  message: string;
  data: {
    database: string;
    status: string;
  };
}

@Controller('health')
export class DatabaseHealthController {
  constructor(private readonly prismaService: PrismaService) {}

  @Get('database')
  async getDatabaseHealth(): Promise<DatabaseHealthResponse> {
    try {
      await this.prismaService.checkConnection();

      return {
        success: true,
        message: 'Database connection is healthy',
        data: {
          database: 'white_label_master',
          status: 'ok',
        },
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown database connection error';

      throw new ServiceUnavailableException({
        success: false,
        message: 'Database connection failed',
        error: message,
      });
    }
  }
}
