import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ActivationTokenService } from './services/activation-token.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { PasswordPolicyService } from './services/password-policy.service';
import { StoreOwnerActivationConfigService } from './services/store-owner-activation-config.service';

@Module({
  imports: [ConfigModule],
  providers: [
    PasswordPolicyService,
    PasswordHasherService,
    ActivationTokenService,
    StoreOwnerActivationConfigService,
  ],
  exports: [
    PasswordPolicyService,
    PasswordHasherService,
    ActivationTokenService,
    StoreOwnerActivationConfigService,
  ],
})
export class StoreAuthModule {}
