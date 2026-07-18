-- Add an explicit trial marker while preserving all existing subscription rows.
ALTER TABLE "billing_subscriptions"
ADD COLUMN "is_trial" BOOLEAN NOT NULL DEFAULT false;

-- Reject invalid custom subscription periods.
ALTER TABLE "billing_subscriptions"
ADD CONSTRAINT "billing_subscriptions_valid_date_range_check"
CHECK ("end_date" IS NULL OR "end_date" > "start_date");

-- Support store subscription history and plan subscription lookups.
CREATE INDEX "billing_subscriptions_store_id_start_date_idx"
ON "billing_subscriptions"("store_id", "start_date");

CREATE INDEX "billing_subscriptions_store_id_end_date_idx"
ON "billing_subscriptions"("store_id", "end_date");

CREATE INDEX "billing_subscriptions_plan_id_idx"
ON "billing_subscriptions"("plan_id");

-- Fail with a clear diagnostic before adding the current-subscription invariant.
DO $$
DECLARE
  conflicting_store_id UUID;
  conflicting_subscription_count BIGINT;
BEGIN
  SELECT "store_id", COUNT(*)
  INTO conflicting_store_id, conflicting_subscription_count
  FROM "billing_subscriptions"
  WHERE "status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'LIFETIME')
  GROUP BY "store_id"
  HAVING COUNT(*) > 1
  ORDER BY "store_id"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot enforce one current subscription per store: store % has % subscriptions with a current operational status',
      conflicting_store_id,
      conflicting_subscription_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "billing_subscriptions_one_current_per_store_uidx"
ON "billing_subscriptions"("store_id")
WHERE "status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'LIFETIME');
