-- CHANGE 1: capability token on Presence.
-- Additive, NOT NULL. Presence rows are transient (reaped within STALE_MS = 15s),
-- so we add the column NULLABLE, stamp existing rows with a placeholder so the
-- NOT NULL can be enforced immediately, then drop the placeholder default. New
-- rows always get a server-issued token from app code (no DB-side default — the
-- token must come from a CSPRNG in the join handler, not from Postgres).
-- The existing primary key on "id" already serves "fetch token for this id";
-- no extra index is added (token is looked up by id, never by token value).

-- AlterTable
ALTER TABLE "Presence" ADD COLUMN "token" TEXT;

-- Stamp any in-flight rows so the NOT NULL constraint can be applied. These rows
-- carry a sentinel that no real client can present, so they cannot authenticate;
-- they are reaped within seconds by the normal lazy-reap on poll.
UPDATE "Presence" SET "token" = 'MIGRATION_PLACEHOLDER_' || "id" WHERE "token" IS NULL;

-- Enforce NOT NULL now that no NULLs remain.
ALTER TABLE "Presence" ALTER COLUMN "token" SET NOT NULL;

-- CHANGE 2: Postgres-backed fixed-window rate-limit counters.
-- One row per (key, route, window). Counters are incremented with a single
-- pool-safe upsert (INSERT ... ON CONFLICT DO UPDATE) and reaped lazily on poll
-- via the "expiresAt" index. No transactions, no cron.

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "window" BIGINT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key", "route", "window")
);

-- CreateIndex
CREATE INDEX "RateLimit_expiresAt_idx" ON "RateLimit"("expiresAt");
