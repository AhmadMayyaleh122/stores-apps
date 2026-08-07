-- CreateEnum
CREATE TYPE "TenantProvisioningStatus" AS ENUM ('PENDING', 'PROVISIONING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "tenant_databases" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "status" "TenantProvisioningStatus" NOT NULL DEFAULT 'PENDING',
    "database_name" TEXT NOT NULL,
    "database_host" TEXT,
    "database_port" INTEGER,
    "database_user" TEXT,
    "database_password_encrypted" TEXT,
    "encryption_key_version" INTEGER,
    "provisioning_started_at" TIMESTAMP(3),
    "provisioned_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "last_failure_code" TEXT,
    "last_failure_message" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_databases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_databases_store_id_key" ON "tenant_databases"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_databases_database_name_key" ON "tenant_databases"("database_name");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_databases_database_user_key" ON "tenant_databases"("database_user");

-- CreateIndex
CREATE INDEX "tenant_databases_status_idx" ON "tenant_databases"("status");

-- CreateIndex
CREATE INDEX "tenant_databases_created_at_idx" ON "tenant_databases"("created_at");

-- AddCheckConstraint
ALTER TABLE "tenant_databases"
ADD CONSTRAINT "tenant_databases_valid_port_check"
CHECK (
    "database_port" IS NULL
    OR "database_port" BETWEEN 1 AND 65535
);

-- AddCheckConstraint
ALTER TABLE "tenant_databases"
ADD CONSTRAINT "tenant_databases_non_negative_attempt_count_check"
CHECK ("attempt_count" >= 0);

-- AddCheckConstraint
ALTER TABLE "tenant_databases"
ADD CONSTRAINT "tenant_databases_ready_connection_details_check"
CHECK (
    "status" <> 'READY'
    OR (
        "database_host" IS NOT NULL
        AND "database_port" IS NOT NULL
        AND "database_user" IS NOT NULL
        AND "database_password_encrypted" IS NOT NULL
        AND "encryption_key_version" IS NOT NULL
        AND "provisioned_at" IS NOT NULL
    )
);

-- AddForeignKey
ALTER TABLE "tenant_databases"
ADD CONSTRAINT "tenant_databases_store_id_fkey"
FOREIGN KEY ("store_id") REFERENCES "stores"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
