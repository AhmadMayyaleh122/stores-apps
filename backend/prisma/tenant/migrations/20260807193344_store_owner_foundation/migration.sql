-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(40),
    "role_id" UUID NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "is_store_owner" BOOLEAN NOT NULL DEFAULT false,
    "master_store_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "employees_email_key" ON "employees"("email");

-- CreateIndex
CREATE UNIQUE INDEX "employees_master_store_id_key" ON "employees"("master_store_id");

-- CreateIndex
CREATE INDEX "employees_role_id_idx" ON "employees"("role_id");

-- CreateIndex
CREATE INDEX "employees_status_idx" ON "employees"("status");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A partial unique index is not expressible in the Prisma schema.
CREATE UNIQUE INDEX "employees_single_store_owner_key"
ON "employees" ("is_store_owner")
WHERE "is_store_owner" = true;

-- Store ownership requires a Master Store identity; regular employees must not carry one.
ALTER TABLE "employees"
ADD CONSTRAINT "employees_store_owner_master_store_id_check"
CHECK (
    ("is_store_owner" = true AND "master_store_id" IS NOT NULL)
    OR ("is_store_owner" = false AND "master_store_id" IS NULL)
);

-- Employee emails are persisted in their canonical form for deterministic uniqueness.
ALTER TABLE "employees"
ADD CONSTRAINT "employees_canonical_email_check"
CHECK (
    "email" = lower(btrim("email"))
    AND length("email") > 0
);
