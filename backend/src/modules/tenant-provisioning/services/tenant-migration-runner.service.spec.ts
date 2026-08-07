import { execFile } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TenantProvisioningError } from '../tenant-provisioning.errors';
import { TenantMigrationRunnerService } from './tenant-migration-runner.service';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  stat: jest.fn(),
}));

class TestTenantMigrationRunnerService extends TenantMigrationRunnerService {
  candidates = [path.resolve('D:/application/backend')];
  prismaCliPath = path.resolve(
    'D:/application/backend/node_modules/prisma/build/index.js',
  );

  protected override getBackendRootCandidates(): string[] {
    return this.candidates;
  }

  protected override resolvePrismaCliPath(): string {
    return this.prismaCliPath;
  }
}

class RealPrismaCliResolver extends TenantMigrationRunnerService {
  resolve(backendRoot: string): string {
    return this.resolvePrismaCliPath(backendRoot);
  }
}

describe('TenantMigrationRunnerService', () => {
  const tenantDatabaseUrl =
    'postgresql://tenant:tenant-secret@tenant.example.test/tenant_db';
  const masterDatabaseUrl =
    'postgresql://master:master-secret@master.example.test/white_label_master';
  const timeout = 120_000;
  const allowedRuntimeEnvironment = {
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NODE_EXTRA_CA_CERTS: '/trusted/extra-ca.pem',
    SSL_CERT_FILE: '/trusted/cert.pem',
    SSL_CERT_DIR: '/trusted/certs',
  };
  const forbiddenEnvironment = {
    PATH: 'C:\\untrusted-bin',
    Path: 'C:\\untrusted-bin',
    PATHEXT: '.EXE;.CMD',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    HOME: '/home/application',
    USERPROFILE: 'C:\\Users\\application',
    NODE_OPTIONS: '--require malicious-module',
    NODE_PATH: '/untrusted/modules',
    POSTGRES_ADMIN_URL: 'postgresql://admin:secret@host/postgres',
    TENANT_SHADOW_DATABASE_URL: 'postgresql://shadow:secret@host/shadow',
    TENANT_CREDENTIAL_ENCRYPTION_KEY_V1: 'encryption-secret',
    ADMIN_JWT_SECRET: 'jwt-secret',
    JWT_ACCESS_SECRET: 'access-secret',
    npm_config_registry: 'https://registry.example.test',
    HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example.test',
    PRISMA_QUERY_ENGINE_BINARY: '/untrusted/query-engine',
    UNRELATED_PROVISIONING_SECRET: 'unrelated-secret',
  };
  const originalEnvironment = process.env;
  let service: TestTenantMigrationRunnerService;
  let execFileMock: jest.Mock;
  let statMock: jest.Mock;

  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      ...allowedRuntimeEnvironment,
      ...forbiddenEnvironment,
      DATABASE_URL: masterDatabaseUrl,
    };
    service = new TestTenantMigrationRunnerService();
    execFileMock = execFile as unknown as jest.Mock;
    statMock = stat as unknown as jest.Mock;
    execFileMock.mockReset();
    statMock.mockReset();
    statMock.mockImplementation(async (assetPath: string) =>
      assetPath.endsWith('migrations')
        ? fakeStat(false, true)
        : fakeStat(true, false),
    );
    execFileMock.mockImplementation(
      (
        _executable: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, 'suppressed stdout', 'suppressed stderr'),
    );
  });

  afterEach(() => {
    process.env = originalEnvironment;
  });

  it('executes the checked-in Prisma CLI with exact safe arguments and options', async () => {
    await service.runMigrations({
      tenantDatabaseUrl,
      tenantMigrationTimeoutMs: timeout,
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [executable, args, options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];

    expect(executable).toBe(process.execPath);
    expect(args).toEqual([
      service.prismaCliPath,
      'migrate',
      'deploy',
      '--config=prisma.tenant.config.ts',
    ]);
    expect(options).toMatchObject({
      cwd: service.candidates[0],
      shell: false,
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    expect(args.join(' ')).not.toContain(tenantDatabaseUrl);
  });

  it('passes URLs only through an isolated child environment', async () => {
    const environmentBefore = { ...process.env };

    await service.runMigrations({
      tenantDatabaseUrl,
      tenantMigrationTimeoutMs: timeout,
    });

    const environment = execFileMock.mock.calls[0][2].env as NodeJS.ProcessEnv;

    expect(environment.TENANT_DATABASE_URL).toBe(tenantDatabaseUrl);
    expect(environment.DATABASE_URL).toBe(masterDatabaseUrl);
    expect(environment.TENANT_SHADOW_DATABASE_URL).toBeUndefined();
    expect(environment.POSTGRES_ADMIN_URL).toBeUndefined();
    expect(environment.TENANT_CREDENTIAL_ENCRYPTION_KEY_V1).toBeUndefined();
    expect(environment.ADMIN_JWT_SECRET).toBeUndefined();
    expect(environment.UNRELATED_PROVISIONING_SECRET).toBeUndefined();
    expect(process.env).toEqual(environmentBefore);
  });

  it.each(Object.entries(allowedRuntimeEnvironment))(
    'preserves allowed runtime variable %s',
    async (key, value) => {
      await service.runMigrations({
        tenantDatabaseUrl,
        tenantMigrationTimeoutMs: timeout,
      });

      const environment = execFileMock.mock.calls[0][2].env as NodeJS.ProcessEnv;

      expect(environment[key]).toBe(value);
    },
  );

  it.each(Object.keys(forbiddenEnvironment))(
    'omits forbidden child variable %s',
    async (key) => {
      await service.runMigrations({
        tenantDatabaseUrl,
        tenantMigrationTimeoutMs: timeout,
      });

      const environment = execFileMock.mock.calls[0][2].env as NodeJS.ProcessEnv;

      expect(environment[key]).toBeUndefined();
    },
  );

  it('constructs an environment containing only the strict allowlist and database URLs', async () => {
    await service.runMigrations({
      tenantDatabaseUrl,
      tenantMigrationTimeoutMs: timeout,
    });

    const environment = execFileMock.mock.calls[0][2].env as NodeJS.ProcessEnv;

    expect(Object.keys(environment).sort()).toEqual(
      [
        ...Object.keys(allowedRuntimeEnvironment),
        'DATABASE_URL',
        'TENANT_DATABASE_URL',
      ].sort(),
    );
  });

  it('cannot rehydrate omitted secrets from an .env in the selected root', async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), 'tenant-migration-runner-'),
    );
    const sentinelValues = [
      'sentinel-admin-secret',
      'sentinel-encryption-secret',
      'sentinel-jwt-secret',
      'sentinel-shadow-secret',
    ];
    const environmentBefore = { ...process.env };

    try {
      const sourceConfigPath = path.resolve(
        __dirname,
        '../../../../prisma.tenant.config.ts',
      );
      const tenantConfig = await readFile(sourceConfigPath, 'utf8');

      expect(tenantConfig).not.toContain('dotenv/config');
      expect(tenantConfig).not.toMatch(/from\s+["']dotenv["']/);
      await writeFile(
        path.join(temporaryRoot, '.env'),
        [
          `POSTGRES_ADMIN_URL=${sentinelValues[0]}`,
          `TENANT_CREDENTIAL_ENCRYPTION_KEY_V1=${sentinelValues[1]}`,
          `ADMIN_JWT_SECRET=${sentinelValues[2]}`,
          `TENANT_SHADOW_DATABASE_URL=${sentinelValues[3]}`,
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(temporaryRoot, 'prisma.tenant.config.ts'),
        tenantConfig,
        'utf8',
      );
      service.candidates = [temporaryRoot];
      service.prismaCliPath = path.join(
        temporaryRoot,
        'node_modules',
        'prisma',
        'build',
        'index.js',
      );
      execFileMock.mockImplementation(
        (
          _executable: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error, stdout: string, stderr: string) => void,
        ) => callback(
          new Error(`child ${sentinelValues[0]}`),
          sentinelValues[1],
          `${sentinelValues[2]} ${sentinelValues[3]}`,
        ),
      );

      await expectMigrationFailure();

      const [executable, args, childOptions] = execFileMock.mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];
      const capturedInvocation = JSON.stringify({
        executable,
        args,
        environment: childOptions.env,
      });

      for (const sentinel of sentinelValues) {
        expect(capturedInvocation).not.toContain(sentinel);
        expect(Object.values(process.env)).not.toContain(sentinel);
      }
      expect(process.env).toEqual(environmentBefore);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('selects only an explicitly verified source or production asset root', async () => {
    const sourceRoot = path.resolve('D:/application/backend');
    const productionRoot = path.resolve('D:/application/backend/dist');
    service.candidates = [sourceRoot, productionRoot];
    statMock.mockImplementation(async (assetPath: string) => {
      if (assetPath === service.prismaCliPath) {
        return fakeStat(true, false);
      }

      if (assetPath.startsWith(sourceRoot) && !assetPath.startsWith(productionRoot)) {
        throw new Error('source assets absent');
      }

      return assetPath.endsWith('migrations')
        ? fakeStat(false, true)
        : fakeStat(true, false);
    });

    await service.runMigrations({
      tenantDatabaseUrl,
      tenantMigrationTimeoutMs: timeout,
    });

    expect(execFileMock.mock.calls[0][2].cwd).toBe(productionRoot);
  });

  it.each([
    'prisma.tenant.config.ts',
    path.join('prisma', 'tenant', 'schema.prisma'),
    path.join('prisma', 'tenant', 'migrations'),
  ])('fails closed before execution when required asset is missing: %s', async (missing) => {
    statMock.mockImplementation(async (assetPath: string) => {
      if (assetPath.endsWith(missing)) {
        throw new Error('missing asset detail');
      }

      return assetPath.endsWith('migrations')
        ? fakeStat(false, true)
        : fakeStat(true, false);
    });

    await expectMigrationFailure();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('fails closed before execution when the Prisma CLI is missing', async () => {
    statMock.mockImplementation(async (assetPath: string) => {
      if (assetPath === service.prismaCliPath) {
        throw new Error('missing CLI detail');
      }

      return assetPath.endsWith('migrations')
        ? fakeStat(false, true)
        : fakeStat(true, false);
    });

    await expectMigrationFailure();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('resolves the real installed local Prisma CLI without npx or network lookup', async () => {
    const resolver = new RealPrismaCliResolver();
    const backendRoot = path.resolve(__dirname, '../../../../');
    const prismaPackageRoot = path.dirname(require.resolve('prisma/package.json'));
    const resolvedPath = resolver.resolve(backendRoot);
    const actualStat = (
      jest.requireActual('node:fs/promises') as typeof import('node:fs/promises')
    ).stat;

    expect((await actualStat(resolvedPath)).isFile()).toBe(true);
    expect(path.isAbsolute(resolvedPath)).toBe(true);
    expect(path.relative(prismaPackageRoot, resolvedPath)).not.toMatch(/^\.\./);
    expect(resolvedPath).toBe(
      require.resolve('prisma/build/index.js', { paths: [backendRoot] }),
    );
    expect(resolvedPath.toLowerCase()).not.toContain('npx');
  });

  it.each([
    new Error('nonzero exit with stderr secret'),
    Object.assign(new Error('timeout with stdout secret'), {
      killed: true,
      signal: 'SIGTERM',
    }),
  ])('maps child failure to a static safe error', async (childError) => {
    execFileMock.mockImplementation(
      (
        _executable: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error, stdout: string, stderr: string) => void,
      ) => callback(childError, 'stdout contains URL', 'stderr contains password'),
    );

    await expectMigrationFailure();
  });

  it('does not expose URLs, output, asset paths, or child details', async () => {
    execFileMock.mockImplementation(
      (
        _executable: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error, stdout: string, stderr: string) => void,
      ) => callback(
        new Error('child detail with tenant-secret'),
        `stdout ${tenantDatabaseUrl}`,
        'stderr password database topology',
      ),
    );

    try {
      await service.runMigrations({
        tenantDatabaseUrl,
        tenantMigrationTimeoutMs: timeout,
      });
      throw new Error('Expected migration to fail');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toBe('Tenant database migration failed.');
      expect(message).not.toContain(tenantDatabaseUrl);
      expect(message).not.toContain('tenant-secret');
      expect(message).not.toContain('stdout');
      expect(message).not.toContain('stderr');
      expect(message).not.toContain(service.prismaCliPath);
    }
  });

  function fakeStat(isFile: boolean, isDirectory: boolean): {
    isFile: () => boolean;
    isDirectory: () => boolean;
  } {
    return {
      isFile: () => isFile,
      isDirectory: () => isDirectory,
    };
  }

  async function expectMigrationFailure(): Promise<void> {
    try {
      await service.runMigrations({
        tenantDatabaseUrl,
        tenantMigrationTimeoutMs: timeout,
      });
      throw new Error('Expected migration to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantProvisioningError);
      expect((error as TenantProvisioningError).code).toBe(
        'TENANT_MIGRATION_FAILED',
      );
      expect((error as Error).message).toBe('Tenant database migration failed.');
    }
  }
});
