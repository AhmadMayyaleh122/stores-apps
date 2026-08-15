import { ConfigService } from '@nestjs/config';

import { StoreAuthErrorCode } from '../store-auth.errors';
import {
  DEFAULT_STORE_OWNER_ACTIVATION_TTL_MINUTES,
  MAX_STORE_OWNER_ACTIVATION_TTL_MINUTES,
  StoreOwnerActivationConfigService,
} from './store-owner-activation-config.service';

describe('StoreOwnerActivationConfigService', () => {
  function createService(value: unknown): StoreOwnerActivationConfigService {
    return new StoreOwnerActivationConfigService({
      get: jest.fn().mockReturnValue(value),
    } as unknown as ConfigService);
  }

  it('uses 1440 minutes when the TTL is missing', () => {
    const configuration = createService(
      undefined,
    ).getActivationConfiguration();

    expect(configuration).toEqual({
      ttlMinutes: DEFAULT_STORE_OWNER_ACTIVATION_TTL_MINUTES,
    });
    expect(Object.isFrozen(configuration)).toBe(true);
  });

  it('accepts a valid configured positive integer', () => {
    expect(createService('60').getActivationConfiguration()).toEqual({
      ttlMinutes: 60,
    });
    expect(createService(60).getActivationConfiguration()).toEqual({
      ttlMinutes: 60,
    });
  });

  it.each(['0', '-1', '1.5', 'not-a-number'])(
    'rejects invalid configured TTL %s',
    (value) => {
      expect(() => createService(value).getActivationConfiguration()).toThrow(
        expect.objectContaining({
          code: StoreAuthErrorCode.CONFIGURATION_INVALID,
        }),
      );
    },
  );

  it('rejects a TTL above the seven-day maximum', () => {
    const value = String(MAX_STORE_OWNER_ACTIVATION_TTL_MINUTES + 1);

    expect(() => createService(value).getActivationConfiguration()).toThrow(
      'Store owner activation configuration is invalid.',
    );
  });

  it('rejects an integer outside the JavaScript safe range', () => {
    expect(() =>
      createService('99999999999999999999').getActivationConfiguration(),
    ).toThrow('Store owner activation configuration is invalid.');
  });

  it('accepts the seven-day maximum', () => {
    expect(
      createService(
        String(MAX_STORE_OWNER_ACTIVATION_TTL_MINUTES),
      ).getActivationConfiguration(),
    ).toEqual({ ttlMinutes: MAX_STORE_OWNER_ACTIVATION_TTL_MINUTES });
  });

  it('does not expose an invalid configured value', () => {
    const invalidValue = 'do-not-expose-invalid-ttl';

    try {
      createService(invalidValue).getActivationConfiguration();
      throw new Error('Expected configuration validation to fail');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(invalidValue);
    }
  });
});
