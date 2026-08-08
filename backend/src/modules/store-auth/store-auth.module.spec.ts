import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigModule } from '@nestjs/config';

import { ActivationTokenService } from './services/activation-token.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { PasswordPolicyService } from './services/password-policy.service';
import { StoreOwnerActivationConfigService } from './services/store-owner-activation-config.service';
import { StoreAuthModule } from './store-auth.module';

describe('StoreAuthModule', () => {
  const expectedPrimitives = [
    PasswordPolicyService,
    PasswordHasherService,
    ActivationTokenService,
    StoreOwnerActivationConfigService,
  ];

  it('imports only ConfigModule and has no controllers', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      StoreAuthModule,
    ) as unknown[];
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      StoreAuthModule,
    ) as unknown[] | undefined;

    expect(imports).toEqual([ConfigModule]);
    expect(controllers ?? []).toEqual([]);
  });

  it('provides and exports the Store authentication primitives', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      StoreAuthModule,
    ) as unknown[];
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      StoreAuthModule,
    ) as unknown[];

    expect(providers).toEqual(expectedPrimitives);
    expect(exports).toEqual(expectedPrimitives);
  });
});
