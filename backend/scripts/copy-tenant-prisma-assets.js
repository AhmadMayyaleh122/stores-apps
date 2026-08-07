const { cp, mkdir, rm, stat } = require('node:fs/promises');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(backendRoot, 'dist');

async function copyTenantPrismaAssets(options = {}) {
  const sourceRoot = options.sourceRoot ?? backendRoot;
  const destinationRoot = options.outputRoot ?? outputRoot;
  const destinationTenantRoot = path.join(
    destinationRoot,
    'prisma',
    'tenant',
  );
  const destinationConfig = path.join(
    destinationRoot,
    'prisma.tenant.config.ts',
  );
  const assets = [
    {
      source: path.join(sourceRoot, 'prisma.tenant.config.ts'),
      destination: destinationConfig,
      directory: false,
    },
    {
      source: path.join(sourceRoot, 'prisma', 'tenant', 'schema.prisma'),
      destination: path.join(destinationTenantRoot, 'schema.prisma'),
      directory: false,
    },
    {
      source: path.join(sourceRoot, 'prisma', 'tenant', 'migrations'),
      destination: path.join(destinationTenantRoot, 'migrations'),
      directory: true,
    },
  ];

  for (const asset of assets) {
    const sourceStat = await stat(asset.source);

    if (
      (asset.directory && !sourceStat.isDirectory()) ||
      (!asset.directory && !sourceStat.isFile())
    ) {
      throw new Error('Required tenant Prisma build asset is missing.');
    }
  }

  await rm(destinationConfig, { force: true });
  await rm(destinationTenantRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });

  for (const asset of assets) {
    await mkdir(path.dirname(asset.destination), { recursive: true });
    await cp(asset.source, asset.destination, {
      recursive: asset.directory,
      force: true,
    });
  }
}

module.exports = { copyTenantPrismaAssets };

if (require.main === module) {
  copyTenantPrismaAssets().catch(() => {
    process.stderr.write('Tenant Prisma build assets could not be copied.\n');
    process.exitCode = 1;
  });
}
