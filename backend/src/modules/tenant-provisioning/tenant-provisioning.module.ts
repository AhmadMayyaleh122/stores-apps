import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TenantCredentialEncryptionService } from './services/tenant-credential-encryption.service';
import { TenantProvisioningConfigService } from './services/tenant-provisioning-config.service';

@Module({
  imports: [ConfigModule],
  providers: [
    TenantProvisioningConfigService,
    TenantCredentialEncryptionService,
  ],
  exports: [
    TenantProvisioningConfigService,
    TenantCredentialEncryptionService,
  ],
})
export class TenantProvisioningModule {}
