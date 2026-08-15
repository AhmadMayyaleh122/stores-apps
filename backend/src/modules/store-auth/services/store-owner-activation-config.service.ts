import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  createStoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';

export const DEFAULT_STORE_OWNER_ACTIVATION_TTL_MINUTES = 1_440;
export const MAX_STORE_OWNER_ACTIVATION_TTL_MINUTES = 10_080;

export interface StoreOwnerActivationConfiguration {
  readonly ttlMinutes: number;
}

@Injectable()
export class StoreOwnerActivationConfigService {
  constructor(private readonly configService: ConfigService) {}

  getActivationConfiguration(): StoreOwnerActivationConfiguration {
    try {
      const configuredTtl = this.configService.get<unknown>(
        'STORE_OWNER_ACTIVATION_TTL_MINUTES',
      );
      const ttlMinutes =
        configuredTtl === undefined || configuredTtl === null
          ? DEFAULT_STORE_OWNER_ACTIVATION_TTL_MINUTES
          : parseTtlMinutes(configuredTtl);

      return Object.freeze({ ttlMinutes });
    } catch {
      throw createStoreAuthError(StoreAuthErrorCode.CONFIGURATION_INVALID);
    }
  }
}

function parseTtlMinutes(value: unknown): number {
  const normalized = typeof value === 'number' ? String(value) : value;

  if (typeof normalized !== 'string' || !/^[1-9]\d*$/.test(normalized)) {
    throw new Error('Invalid activation TTL');
  }

  const parsed = Number(normalized);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed > MAX_STORE_OWNER_ACTIVATION_TTL_MINUTES
  ) {
    throw new Error('Invalid activation TTL');
  }

  return parsed;
}
