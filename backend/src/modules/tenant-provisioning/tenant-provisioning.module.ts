import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PostgresTenantProvisionerService } from './services/postgres-tenant-provisioner.service';
import { TenantCredentialEncryptionService } from './services/tenant-credential-encryption.service';
import { TenantIdentityInitializerService } from './services/tenant-identity-initializer.service';
import { TenantMigrationRunnerService } from './services/tenant-migration-runner.service';
import { TenantProvisioningConfigService } from './services/tenant-provisioning-config.service';

@Module({
  imports: [ConfigModule],
  providers: [
    TenantProvisioningConfigService,
    TenantCredentialEncryptionService,
    PostgresTenantProvisionerService,
    TenantMigrationRunnerService,
    TenantIdentityInitializerService,
  ],
  exports: [
    TenantProvisioningConfigService,
    TenantCredentialEncryptionService,
    PostgresTenantProvisionerService,
    TenantMigrationRunnerService,
    TenantIdentityInitializerService,
  ],
})
export class TenantProvisioningModule {}
