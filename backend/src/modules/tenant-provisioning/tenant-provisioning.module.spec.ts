import { MODULE_METADATA } from '@nestjs/common/constants';

import { TenantOwnerInitializerService } from './services/tenant-owner-initializer.service';
import { TenantProvisioningModule } from './tenant-provisioning.module';

describe('TenantProvisioningModule', () => {
  it('provides and exports TenantOwnerInitializerService without invoking it', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      TenantProvisioningModule,
    ) as unknown[];
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      TenantProvisioningModule,
    ) as unknown[];

    expect(providers).toContain(TenantOwnerInitializerService);
    expect(exports).toContain(TenantOwnerInitializerService);
  });
});
