import { URL } from "node:url";

import { defineConfig } from "prisma/config";

// Callers must supply tenant migration environment explicitly. Automatic .env
// loading is intentionally disabled so isolated migration processes stay isolated.

interface DatabaseTarget {
  hostname: string;
  port: number;
  databaseName: string;
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");

  if (
    normalized === "localhost" ||
    normalized.startsWith("127.") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  ) {
    return "loopback";
  }

  return normalized;
}

function parseDatabaseTarget(value: string, label: string): DatabaseTarget {
  try {
    const url = new URL(value);

    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
      throw new Error("Unsupported database protocol");
    }

    const port = url.port ? Number(url.port) : 5432;
    const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Invalid database port");
    }

    if (!databaseName) {
      throw new Error("Missing database name");
    }

    return {
      hostname: normalizeHostname(url.hostname),
      port,
      databaseName,
    };
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL database URL.`);
  }
}

function targetsMatch(left: DatabaseTarget, right: DatabaseTarget): boolean {
  return (
    left.hostname === right.hostname &&
    left.port === right.port &&
    left.databaseName === right.databaseName
  );
}

const masterDatabaseUrl = process.env["DATABASE_URL"];
const tenantDatabaseUrl = process.env["TENANT_DATABASE_URL"];
const tenantShadowDatabaseUrl = process.env["TENANT_SHADOW_DATABASE_URL"];

const masterTarget =
  masterDatabaseUrl && (tenantDatabaseUrl || tenantShadowDatabaseUrl)
    ? parseDatabaseTarget(masterDatabaseUrl, "Master database URL")
    : undefined;
const tenantTarget = tenantDatabaseUrl
  ? parseDatabaseTarget(tenantDatabaseUrl, "Tenant database URL")
  : undefined;
const tenantShadowTarget = tenantShadowDatabaseUrl
  ? parseDatabaseTarget(tenantShadowDatabaseUrl, "Tenant shadow database URL")
  : undefined;

if (masterTarget && tenantTarget && targetsMatch(masterTarget, tenantTarget)) {
  throw new Error("Tenant database must not target the master database.");
}

if (
  tenantShadowTarget &&
  ((masterTarget && targetsMatch(masterTarget, tenantShadowTarget)) ||
    (tenantTarget && targetsMatch(tenantTarget, tenantShadowTarget)))
) {
  throw new Error(
    "Tenant shadow database must be different from the master and tenant databases.",
  );
}

export default defineConfig({
  schema: "prisma/tenant/schema.prisma",
  migrations: {
    path: "prisma/tenant/migrations",
  },
  datasource: {
    ...(tenantDatabaseUrl ? { url: tenantDatabaseUrl } : {}),
    ...(tenantShadowDatabaseUrl
      ? { shadowDatabaseUrl: tenantShadowDatabaseUrl }
      : {}),
  },
});
