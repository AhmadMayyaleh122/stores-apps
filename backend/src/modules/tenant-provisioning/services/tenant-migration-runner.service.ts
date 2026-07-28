import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';

import {
  TenantProvisioningError,
  TenantProvisioningErrorCode,
} from '../tenant-provisioning.errors';

const MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024;
const REQUIRED_RUNTIME_ENVIRONMENT_KEYS = [
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

export interface RunTenantMigrationsOptions {
  tenantDatabaseUrl: string;
  tenantMigrationTimeoutMs: number;
}

@Injectable()
export class TenantMigrationRunnerService {
  async runMigrations(options: RunTenantMigrationsOptions): Promise<void> {
    try {
      validateOptions(options);
      const backendRoot = await this.resolveBackendRoot();
      const prismaCliPath = this.resolvePrismaCliPath(backendRoot);

      if (!(await isFile(prismaCliPath))) {
        throwMigrationFailed();
      }

      const environment = buildChildEnvironment(options.tenantDatabaseUrl);

      await executePrismaCli(
        process.execPath,
        prismaCliPath,
        backendRoot,
        environment,
        options.tenantMigrationTimeoutMs,
      );
    } catch (error) {
      if (
        error instanceof TenantProvisioningError &&
        error.code === TenantProvisioningErrorCode.MIGRATION_FAILED
      ) {
        throw error;
      }

      throwMigrationFailed();
    }
  }

  protected getBackendRootCandidates(): string[] {
    return [
      path.resolve(__dirname, '../../../..'),
      path.resolve(process.cwd()),
    ];
  }

  protected resolvePrismaCliPath(backendRoot: string): string {
    return require.resolve('prisma/build/index.js', {
      paths: [backendRoot, path.resolve(backendRoot, '..')],
    });
  }

  private async resolveBackendRoot(): Promise<string> {
    const candidates = [...new Set(this.getBackendRootCandidates())];

    for (const candidate of candidates) {
      if (await hasRequiredTenantAssets(candidate)) {
        return candidate;
      }
    }

    throwMigrationFailed();
  }
}

function validateOptions(options: RunTenantMigrationsOptions): void {
  if (
    typeof options.tenantDatabaseUrl !== 'string' ||
    options.tenantDatabaseUrl.trim().length === 0 ||
    !Number.isInteger(options.tenantMigrationTimeoutMs) ||
    options.tenantMigrationTimeoutMs < 1
  ) {
    throwMigrationFailed();
  }
}

async function hasRequiredTenantAssets(backendRoot: string): Promise<boolean> {
  try {
    const config = await stat(path.join(backendRoot, 'prisma.tenant.config.ts'));
    const schema = await stat(
      path.join(backendRoot, 'prisma', 'tenant', 'schema.prisma'),
    );
    const migrations = await stat(
      path.join(backendRoot, 'prisma', 'tenant', 'migrations'),
    );

    return config.isFile() && schema.isFile() && migrations.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function buildChildEnvironment(tenantDatabaseUrl: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const key of REQUIRED_RUNTIME_ENVIRONMENT_KEYS) {
    const value = process.env[key];

    if (value !== undefined) {
      environment[key] = value;
    }
  }

  if (process.env.DATABASE_URL !== undefined) {
    environment.DATABASE_URL = process.env.DATABASE_URL;
  }

  environment.TENANT_DATABASE_URL = tenantDatabaseUrl;

  return environment;
}

function executePrismaCli(
  executable: string,
  prismaCliPath: string,
  backendRoot: string,
  environment: NodeJS.ProcessEnv,
  timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [
        prismaCliPath,
        'migrate',
        'deploy',
        '--config=prisma.tenant.config.ts',
      ],
      {
        cwd: backendRoot,
        env: environment,
        timeout,
        maxBuffer: MAX_OUTPUT_BUFFER_BYTES,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error) => {
        if (error) {
          reject(createMigrationError());
          return;
        }

        resolve();
      },
    );
  });
}

function createMigrationError(): TenantProvisioningError {
  return new TenantProvisioningError(
    TenantProvisioningErrorCode.MIGRATION_FAILED,
    'Tenant database migration failed.',
  );
}

function throwMigrationFailed(): never {
  throw createMigrationError();
}
