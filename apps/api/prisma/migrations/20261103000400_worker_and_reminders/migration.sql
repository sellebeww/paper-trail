-- Copyright (c) 2026 Vassel Goleyu. All rights reserved.
-- Reminder schedules (worker sends them) and a least-privilege database role for apps/worker.

CREATE TABLE "reminder_schedules" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ledger_id" UUID,
    "days_of_week" INTEGER[],
    "time_of_day" CHAR(5) NOT NULL,
    "timezone" VARCHAR(20) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reminder_deliveries" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reminder_schedules_enabled_next_run_at_idx" ON "reminder_schedules"("enabled", "next_run_at");
CREATE INDEX "reminder_schedules_user_id_idx" ON "reminder_schedules"("user_id");
CREATE UNIQUE INDEX "reminder_deliveries_schedule_id_scheduled_for_key" ON "reminder_deliveries"("schedule_id", "scheduled_for");

ALTER TABLE "reminder_schedules" ADD CONSTRAINT "reminder_schedules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reminder_schedules" ADD CONSTRAINT "reminder_schedules_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "ledgers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "reminder_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reminder_schedules"
  ADD CONSTRAINT "reminder_schedules_days" CHECK (
    cardinality(days_of_week) BETWEEN 1 AND 7 AND days_of_week <@ ARRAY[1,2,3,4,5,6,7]
  ),
  ADD CONSTRAINT "reminder_schedules_time" CHECK (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT "reminder_schedules_timezone" CHECK (timezone IN ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'));

---------------------------------------------------------------------------------------------------
-- Least-privilege role for apps/worker (docs/OPERATIONS.md, "Database role").
-- pt_worker cannot log in; a login role is created per environment with `pnpm --filter
-- @paper-trail/worker db:role` and is made a member. The worker can read the chain but never write it.
-- Creating a role needs CREATEROLE (the docker-compose user has it).
---------------------------------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pt_worker') THEN
    CREATE ROLE pt_worker NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO pt_worker;
GRANT SELECT ON "ledgers", "entries" TO pt_worker;
GRANT SELECT ("id", "email") ON "users" TO pt_worker;
GRANT SELECT, INSERT, UPDATE ON "anchors" TO pt_worker;
GRANT SELECT ON "reminder_schedules" TO pt_worker;
GRANT UPDATE ("next_run_at") ON "reminder_schedules" TO pt_worker;
GRANT SELECT, INSERT ON "reminder_deliveries" TO pt_worker;
