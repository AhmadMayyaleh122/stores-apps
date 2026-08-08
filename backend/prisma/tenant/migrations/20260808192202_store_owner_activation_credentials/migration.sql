-- CreateTable
CREATE TABLE "employee_credentials" (
    "employee_id" UUID NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_credentials_pkey" PRIMARY KEY ("employee_id")
);

-- CreateTable
CREATE TABLE "employee_activation_tokens" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_activation_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_activation_tokens_token_hash_key" ON "employee_activation_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "employee_activation_tokens_employee_id_idx" ON "employee_activation_tokens"("employee_id");

-- CreateIndex
CREATE INDEX "employee_activation_tokens_expires_at_idx" ON "employee_activation_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "employee_credentials" ADD CONSTRAINT "employee_credentials_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_activation_tokens" ADD CONSTRAINT "employee_activation_tokens_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Password hashes are opaque encoded values, but an empty value is never valid.
ALTER TABLE "employee_credentials"
ADD CONSTRAINT "employee_credentials_password_hash_nonempty_check"
CHECK (length("password_hash") > 0);

-- Activation tokens are stored only as fixed-size SHA-256 digests.
ALTER TABLE "employee_activation_tokens"
ADD CONSTRAINT "employee_activation_tokens_token_hash_length_check"
CHECK (octet_length("token_hash") = 32);

-- Activation tokens must expire strictly after they are created.
ALTER TABLE "employee_activation_tokens"
ADD CONSTRAINT "employee_activation_tokens_expiry_order_check"
CHECK ("expires_at" > "created_at");

-- Consumption and revocation are mutually exclusive terminal states.
ALTER TABLE "employee_activation_tokens"
ADD CONSTRAINT "employee_activation_tokens_terminal_state_check"
CHECK (NOT ("consumed_at" IS NOT NULL AND "revoked_at" IS NOT NULL));

-- Terminal timestamps cannot precede token creation.
ALTER TABLE "employee_activation_tokens"
ADD CONSTRAINT "employee_activation_tokens_consumed_at_check"
CHECK ("consumed_at" IS NULL OR "consumed_at" >= "created_at");

ALTER TABLE "employee_activation_tokens"
ADD CONSTRAINT "employee_activation_tokens_revoked_at_check"
CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at");

-- Expired tokens intentionally remain outstanding until reissue revokes them.
CREATE UNIQUE INDEX "employee_activation_tokens_one_outstanding_per_employee_key"
ON "employee_activation_tokens" ("employee_id")
WHERE "consumed_at" IS NULL
  AND "revoked_at" IS NULL;
