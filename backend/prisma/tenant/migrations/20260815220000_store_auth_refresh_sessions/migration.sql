-- CreateTable
CREATE TABLE "employee_refresh_sessions" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "refresh_token_hash" BYTEA NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "employee_refresh_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_refresh_sessions_refresh_token_hash_key"
ON "employee_refresh_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "employee_refresh_sessions_employee_id_idx"
ON "employee_refresh_sessions"("employee_id");

-- CreateIndex
CREATE INDEX "employee_refresh_sessions_expires_at_idx"
ON "employee_refresh_sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "employee_refresh_sessions"
ADD CONSTRAINT "employee_refresh_sessions_employee_id_fkey"
FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Refresh tokens are persisted only as fixed-size SHA-256 digests.
ALTER TABLE "employee_refresh_sessions"
ADD CONSTRAINT "employee_refresh_sessions_refresh_token_hash_length_check"
CHECK (octet_length("refresh_token_hash") = 32);

-- Session expiry must be strictly later than the authoritative issue time.
ALTER TABLE "employee_refresh_sessions"
ADD CONSTRAINT "employee_refresh_sessions_expiry_order_check"
CHECK ("expires_at" > "issued_at");

-- Revocation time, when present, cannot precede session issuance.
ALTER TABLE "employee_refresh_sessions"
ADD CONSTRAINT "employee_refresh_sessions_revoked_at_check"
CHECK ("revoked_at" IS NULL OR "revoked_at" >= "issued_at");
