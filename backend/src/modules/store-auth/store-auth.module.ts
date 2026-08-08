import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../../database/database.module';
import { TenantCredentialEncryptionService } from '../tenant-provisioning/services/tenant-credential-encryption.service';
import { TenantProvisioningConfigService } from '../tenant-provisioning/services/tenant-provisioning-config.service';
import { ActivationTokenService } from './services/activation-token.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { PasswordPolicyService } from './services/password-policy.service';
import { StoreOwnerActivationConfigService } from './services/store-owner-activation-config.service';
import { StoreTenantAccessService } from './services/store-tenant-access.service';

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    PasswordPolicyService,
    PasswordHasherService,
    ActivationTokenService,
    StoreOwnerActivationConfigService,
    TenantProvisioningConfigService,
    TenantCredentialEncryptionService,
    StoreTenantAccessService,
  ],
  exports: [
    PasswordPolicyService,
    PasswordHasherService,
    ActivationTokenService,
    StoreOwnerActivationConfigService,
    StoreTenantAccessService,
  ],
})
export class StoreAuthModule {}
