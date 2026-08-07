import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const { copyTenantPrismaAssets } = require('../../../../scripts/copy-tenant-prisma-assets.js') as {
  copyTenantPrismaAssets(options: {
    sourceRoot: string;
    outputRoot: string;
  }): Promise<void>;
};

const INITIAL_MIGRATION = '20260728194854_init_tenant_schema';
const STORE_OWNER_MIGRATION = '20260807193344_store_owner_foundation';

describe('copyTenantPrismaAssets', () => {
  let temporaryRoot: string;
  let sourceRoot: string;
  let outputRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), 'tenant-prisma-assets-'),
    );
    sourceRoot = path.join(temporaryRoot, 'backend');
    outputRoot = path.join(temporaryRoot, 'dist');
    await createSourceAssets();
    await mkdir(
      path.join(outputRoot, 'prisma', 'tenant', 'migrations', 'stale'),
      { recursive: true },
    );
    await writeFile(
      path.join(
        outputRoot,
        'prisma',
        'tenant',
        'migrations',
        'stale',
        'migration.sql',
      ),
      'stale migration',
      'utf8',
    );
    await mkdir(path.join(outputRoot, 'src'), { recursive: true });
    await writeFile(
      path.join(outputRoot, 'src', 'main.js'),
      'compiled application',
      'utf8',
    );
    await mkdir(path.join(outputRoot, 'generated', 'tenant-prisma'), {
      recursive: true,
    });
    await writeFile(
      path.join(outputRoot, 'generated', 'tenant-prisma', 'client.js'),
      'generated tenant client',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('replaces stale tenant assets and copies only current tenant files', async () => {
    await copyTenantPrismaAssets({ sourceRoot, outputRoot });

    await expect(
      access(
        path.join(
          outputRoot,
          'prisma',
          'tenant',
          'migrations',
          'stale',
          'migration.sql',
        ),
      ),
    ).rejects.toBeDefined();
    expect(
      await sortedNames(path.join(outputRoot, 'prisma', 'tenant')),
    ).toEqual(['migrations', 'schema.prisma']);
    expect(
      await sortedNames(
        path.join(outputRoot, 'prisma', 'tenant', 'migrations'),
      ),
    ).toEqual([
      INITIAL_MIGRATION,
      STORE_OWNER_MIGRATION,
      'migration_lock.toml',
    ]);
    expect(
      await sortedNames(
        path.join(
          outputRoot,
          'prisma',
          'tenant',
          'migrations',
          INITIAL_MIGRATION,
        ),
      ),
    ).toEqual(['migration.sql']);
    expect(
      await sortedNames(
        path.join(
          outputRoot,
          'prisma',
          'tenant',
          'migrations',
          STORE_OWNER_MIGRATION,
        ),
      ),
    ).toEqual(['migration.sql']);
    await expectFileContentsMatch(
      'prisma.tenant.config.ts',
      'prisma.tenant.config.ts',
    );
    await expectFileContentsMatch(
      path.join('prisma', 'tenant', 'schema.prisma'),
      path.join('prisma', 'tenant', 'schema.prisma'),
    );
    await expectFileContentsMatch(
      path.join('prisma', 'tenant', 'migrations', 'migration_lock.toml'),
      path.join('prisma', 'tenant', 'migrations', 'migration_lock.toml'),
    );
    await expectFileContentsMatch(
      path.join(
        'prisma',
        'tenant',
        'migrations',
        INITIAL_MIGRATION,
        'migration.sql',
      ),
      path.join(
        'prisma',
        'tenant',
        'migrations',
        INITIAL_MIGRATION,
        'migration.sql',
      ),
    );
    await expectFileContentsMatch(
      path.join(
        'prisma',
        'tenant',
        'migrations',
        STORE_OWNER_MIGRATION,
        'migration.sql',
      ),
      path.join(
        'prisma',
        'tenant',
        'migrations',
        STORE_OWNER_MIGRATION,
        'migration.sql',
      ),
    );
    await expect(
      access(path.join(outputRoot, '.env')),
    ).rejects.toBeDefined();
    await expect(
      access(path.join(outputRoot, 'prisma', 'migrations')),
    ).rejects.toBeDefined();
    await expect(
      readFile(path.join(outputRoot, 'src', 'main.js'), 'utf8'),
    ).resolves.toBe('compiled application');
    await expect(
      readFile(
        path.join(outputRoot, 'generated', 'tenant-prisma', 'client.js'),
        'utf8',
      ),
    ).resolves.toBe('generated tenant client');

    await copyTenantPrismaAssets({ sourceRoot, outputRoot });
    expect(
      await sortedNames(path.join(outputRoot, 'prisma', 'tenant')),
    ).toEqual(['migrations', 'schema.prisma']);
  });

  it('fails before deleting existing output when a required source is missing', async () => {
    await rm(path.join(sourceRoot, 'prisma', 'tenant', 'schema.prisma'));

    await expect(
      copyTenantPrismaAssets({ sourceRoot, outputRoot }),
    ).rejects.toBeDefined();
    await expect(
      readFile(
        path.join(
          outputRoot,
          'prisma',
          'tenant',
          'migrations',
          'stale',
          'migration.sql',
        ),
        'utf8',
      ),
    ).resolves.toBe('stale migration');
  });

  async function createSourceAssets(): Promise<void> {
    const tenantMigrationRoot = path.join(
      sourceRoot,
      'prisma',
      'tenant',
      'migrations',
    );
    await mkdir(
      path.join(tenantMigrationRoot, INITIAL_MIGRATION),
      { recursive: true },
    );
    await mkdir(path.join(tenantMigrationRoot, STORE_OWNER_MIGRATION), {
      recursive: true,
    });
    await writeFile(
      path.join(sourceRoot, 'prisma.tenant.config.ts'),
      'tenant config',
      'utf8',
    );
    await writeFile(
      path.join(sourceRoot, 'prisma', 'tenant', 'schema.prisma'),
      'tenant schema',
      'utf8',
    );
    await writeFile(
      path.join(tenantMigrationRoot, 'migration_lock.toml'),
      'provider = "postgresql"',
      'utf8',
    );
    await writeFile(
      path.join(
        tenantMigrationRoot,
        INITIAL_MIGRATION,
        'migration.sql',
      ),
      'CREATE TABLE tenant_identity ();',
      'utf8',
    );
    await writeFile(
      path.join(
        tenantMigrationRoot,
        STORE_OWNER_MIGRATION,
        'migration.sql',
      ),
      'CREATE TABLE roles (); CREATE TABLE employees ();',
      'utf8',
    );
    await writeFile(path.join(sourceRoot, '.env'), 'SECRET=do-not-copy', 'utf8');
    await mkdir(path.join(sourceRoot, 'prisma', 'migrations'), {
      recursive: true,
    });
    await writeFile(
      path.join(sourceRoot, 'prisma', 'migrations', 'master.sql'),
      'master migration',
      'utf8',
    );
  }

  async function sortedNames(directory: string): Promise<string[]> {
    return (await readdir(directory)).sort();
  }

  async function expectFileContentsMatch(
    sourceRelativePath: string,
    destinationRelativePath: string,
  ): Promise<void> {
    const source = await readFile(
      path.join(sourceRoot, sourceRelativePath),
      'utf8',
    );
    const destination = await readFile(
      path.join(outputRoot, destinationRelativePath),
      'utf8',
    );

    expect(destination).toBe(source);
  }
});
