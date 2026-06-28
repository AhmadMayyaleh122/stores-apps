import { Injectable } from '@nestjs/common';

export interface HealthResponse {
  success: true;
  message: string;
  data: {
    service: string;
    status: string;
  };
}

@Injectable()
export class AppService {
  getHealth(): HealthResponse {
    return {
      success: true,
      message: 'White-label commerce backend is running',
      data: {
        service: 'backend-api',
        status: 'ok',
      },
    };
  }
}
