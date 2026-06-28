import { Injectable, OnModuleDestroy } from '@nestjs/common';

import { Prisma, PrismaClient } from '../../generated/prisma/client';

type PrismaAdapter = NonNullable<Prisma.PrismaClientOptions['adapter']>;

type PrismaPgConstructor = new (options: {
  connectionString: string;
}) => PrismaAdapter;

type PrismaPgModule = {
  PrismaPg: PrismaPgConstructor;
};

function createMissingAdapter(): PrismaAdapter {
  return {
    adapterName: 'missing-prisma-pg-adapter',
    provider: 'postgres',
    async connect() {
      throw new Error(
        'PostgreSQL Prisma adapter is not installed. Install @prisma/adapter-pg to enable direct PostgreSQL connections with this generated Prisma Client.',
      );
    },
  };
}

function createPrismaClientOptions(): Prisma.PrismaClientOptions {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    return {
      adapter: createMissingAdapter(),
    };
  }

  try {
    // The generated Prisma 7 client requires a driver adapter for direct PostgreSQL connections.
    // Keep this dynamic so the app can build even if the adapter has not been installed yet.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaPg } = require('@prisma/adapter-pg') as PrismaPgModule;

    return {
      adapter: new PrismaPg({ connectionString }),
    };
  } catch {
    return {
      adapter: createMissingAdapter(),
    };
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super(createPrismaClientOptions());
  }

  async checkConnection(): Promise<void> {
    await this.$queryRawUnsafe('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
