-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "tenant_identity" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "master_store_id" UUID NOT NULL,
    "initialized_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_identity_master_store_id_key" ON "tenant_identity"("master_store_id");

-- AddCheckConstraint
ALTER TABLE "tenant_identity"
ADD CONSTRAINT "tenant_identity_singleton_check"
CHECK ("id" = 1);
