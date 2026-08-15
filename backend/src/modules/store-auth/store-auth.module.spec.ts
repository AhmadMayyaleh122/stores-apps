import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

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
import { StoreAuthController } from './store-auth.controller';
import { StoreAuthModule } from './store-auth.module';

describe('StoreAuthModule', () => {
  const expectedPrimitives = [
    PasswordPolicyService,
    PasswordHasherService,
    ActivationTokenService,
    StoreOwnerActivationConfigService,
    StoreOwnerActivationService,
    StoreOwnerLoginService,
    StoreAccessTokenService,
    StoreAuthenticationSessionService,
    StoreTenantAccessService,
  ];

  it('imports only the narrow configuration, Master database, and JWT modules', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      StoreAuthModule,
    ) as unknown[];
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      StoreAuthModule,
    ) as unknown[] | undefined;

    expect(imports).toHaveLength(3);
    expect(imports.slice(0, 2)).toEqual([ConfigModule, DatabaseModule]);
    expect(imports[2]).toMatchObject({ module: JwtModule });
    expect(controllers).toEqual([StoreAuthController]);
  });

  it('provides the access dependencies and exports only Store Auth services', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      StoreAuthModule,
    ) as unknown[];
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      StoreAuthModule,
    ) as unknown[];

    expect(providers).toEqual([
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
    ]);
    expect(exports).toEqual(expectedPrimitives);
  });

  it('compiles the real dependency graph without opening a database connection', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      const moduleRef = await Test.createTestingModule({
        imports: [StoreAuthModule],
      }).compile();

      expect(moduleRef.get(StoreTenantAccessService)).toBeInstanceOf(
        StoreTenantAccessService,
      );
      expect(moduleRef.get(StoreOwnerActivationService)).toBeInstanceOf(
        StoreOwnerActivationService,
      );
      expect(moduleRef.get(StoreOwnerLoginService)).toBeInstanceOf(
        StoreOwnerLoginService,
      );
      expect(moduleRef.get(StoreAccessTokenService)).toBeInstanceOf(
        StoreAccessTokenService,
      );
      expect(moduleRef.get(StoreAuthenticationSessionService)).toBeInstanceOf(
        StoreAuthenticationSessionService,
      );
      expect(moduleRef.get(StoreAuthController)).toBeInstanceOf(
        StoreAuthController,
      );
      await moduleRef.close();
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });
});
