import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { DatabaseModule } from '../../database/database.module';
import { TenantCredentialEncryptionService } from '../tenant-provisioning/services/tenant-credential-encryption.service';
import { TenantProvisioningConfigService } from '../tenant-provisioning/services/tenant-provisioning-config.service';
import { ActivationTokenService } from './services/activation-token.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { PasswordPolicyService } from './services/password-policy.service';
import { RefreshTokenService } from './services/refresh-token.service';
import { StoreAccessTokenService } from './services/store-access-token.service';
import { StoreAuthenticationSessionService } from './services/store-authentication-session.service';
import { StoreAuthSessionConfigService } from './services/store-auth-session-config.service';
import { StoreOwnerActivationConfigService } from './services/store-owner-activation-config.service';
import { StoreOwnerActivationService } from './services/store-owner-activation.service';
import { StoreOwnerLoginService } from './services/store-owner-login.service';
import { StoreTenantAccessService } from './services/store-tenant-access.service';

@Module({
  imports: [ConfigModule, DatabaseModule, JwtModule.register({})],
  providers: [
    PasswordPolicyService,
    PasswordHasherService,
    ActivationTokenService,
    StoreOwnerActivationConfigService,
    StoreOwnerActivationService,
    StoreOwnerLoginService,
    StoreAuthSessionConfigService,
    RefreshTokenService,
    StoreAccessTokenService,
    StoreAuthenticationSessionService,
    TenantProvisioningConfigService,
    TenantCredentialEncryptionService,
    StoreTenantAccessService,
  ],
  exports: [
    PasswordPolicyService,
    PasswordHasherService,
    ActivationTokenService,
    StoreOwnerActivationConfigService,
    StoreOwnerActivationService,
    StoreOwnerLoginService,
    StoreAccessTokenService,
    StoreAuthenticationSessionService,
    StoreTenantAccessService,
  ],
})
export class StoreAuthModule {}
