import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { DatabaseModule } from '../../database/database.module';
import { TenantCredentialEncryptionService } from '../tenant-provisioning/services/tenant-credential-encryption.service';
import { TenantProvisioningConfigService } from '../tenant-provisioning/services/tenant-provisioning-config.service';
import { ActivationTokenService } from './services/activation-token.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { PasswordPolicyService } from './services/password-policy.service';
import { StoreOwnerActivationConfigService } from './services/store-owner-activation-config.service';
import { StoreTenantAccessService } from './services/store-tenant-access.service';
import { StoreAuthModule } from './store-auth.module';

describe('StoreAuthModule', () => {
  const expectedPrimitives = [
    PasswordPolicyService,
    PasswordHasherService,
    ActivationTokenService,
    StoreOwnerActivationConfigService,
    StoreTenantAccessService,
  ];

  it('imports only the narrow configuration and Master database modules', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      StoreAuthModule,
    ) as unknown[];
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      StoreAuthModule,
    ) as unknown[] | undefined;

    expect(imports).toEqual([ConfigModule, DatabaseModule]);
    expect(controllers ?? []).toEqual([]);
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
