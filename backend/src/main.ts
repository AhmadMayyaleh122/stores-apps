import 'reflect-metadata';

import { ValidationPipe, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.setGlobalPrefix('api', {
    exclude: [
      { path: '/', method: RequestMethod.GET },
      { path: 'health/database', method: RequestMethod.GET },
      { path: 'admin/auth/login', method: RequestMethod.POST },
      { path: 'admin/auth/me', method: RequestMethod.GET },
      { path: 'admin/stores', method: RequestMethod.POST },
      { path: 'admin/stores', method: RequestMethod.GET },
      { path: 'admin/stores/:id', method: RequestMethod.GET },
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors();

  const port = configService.get<number>('PORT') ?? 3000;

  await app.listen(port);
}

void bootstrap();
