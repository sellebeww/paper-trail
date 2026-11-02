-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ledger_category" AS ENUM ('kerja', 'sewa', 'freelance', 'gig', 'lainnya');

-- CreateEnum
CREATE TYPE "entry_type" AS ENUM ('note', 'photo', 'file', 'witness_cosign');

-- CreateEnum
CREATE TYPE "anchor_status" AS ENUM ('pending', 'ok', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledgers" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "category" "ledger_category" NOT NULL,
    "head_seq" INTEGER,
    "head_hash" CHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entries" (
    "id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" "entry_type" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "author_ref" VARCHAR(140) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "prev_hash" CHAR(64) NOT NULL,
    "entry_hash" CHAR(64) NOT NULL,

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "witness_invites" (
    "id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "target_entry_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "witness_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "witnesses" (
    "id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "invite_id" UUID NOT NULL,
    "target_entry_id" UUID NOT NULL,
    "cosign_entry_id" UUID NOT NULL,
    "display_name" VARCHAR(80),
    "public_key" VARCHAR(100) NOT NULL,
    "signature" VARCHAR(100) NOT NULL,
    "signed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "witnesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anchors" (
    "id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "anchored_head_seq" INTEGER NOT NULL,
    "anchored_head_hash" CHAR(64) NOT NULL,
    "anchor_digest" CHAR(64) NOT NULL,
    "tsa_url" TEXT NOT NULL,
    "tst_token" BYTEA,
    "tst_gen_time" TIMESTAMPTZ(3),
    "status" "anchor_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "anchors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "ledgers_owner_id_idx" ON "ledgers"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "entries_ledger_id_seq_key" ON "entries"("ledger_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "entries_ledger_id_entry_hash_key" ON "entries"("ledger_id", "entry_hash");

-- CreateIndex
CREATE UNIQUE INDEX "entries_ledger_id_seq_entry_hash_key" ON "entries"("ledger_id", "seq", "entry_hash");

-- CreateIndex
CREATE UNIQUE INDEX "entries_ledger_id_id_key" ON "entries"("ledger_id", "id");

-- CreateIndex
CREATE INDEX "attachments_entry_id_idx" ON "attachments"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "witness_invites_token_hash_key" ON "witness_invites"("token_hash");

-- CreateIndex
CREATE INDEX "witness_invites_ledger_id_idx" ON "witness_invites"("ledger_id");

-- CreateIndex
CREATE UNIQUE INDEX "witnesses_invite_id_key" ON "witnesses"("invite_id");

-- CreateIndex
CREATE UNIQUE INDEX "witnesses_cosign_entry_id_key" ON "witnesses"("cosign_entry_id");

-- CreateIndex
CREATE INDEX "witnesses_ledger_id_idx" ON "witnesses"("ledger_id");

-- CreateIndex
CREATE UNIQUE INDEX "anchors_ledger_id_anchored_head_seq_key" ON "anchors"("ledger_id", "anchored_head_seq");

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "ledgers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "witness_invites" ADD CONSTRAINT "witness_invites_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "witness_invites" ADD CONSTRAINT "witness_invites_ledger_id_target_entry_id_fkey" FOREIGN KEY ("ledger_id", "target_entry_id") REFERENCES "entries"("ledger_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "witnesses" ADD CONSTRAINT "witnesses_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "witnesses" ADD CONSTRAINT "witnesses_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "witness_invites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "witnesses" ADD CONSTRAINT "witnesses_ledger_id_target_entry_id_fkey" FOREIGN KEY ("ledger_id", "target_entry_id") REFERENCES "entries"("ledger_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "witnesses" ADD CONSTRAINT "witnesses_cosign_entry_id_fkey" FOREIGN KEY ("cosign_entry_id") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "anchors" ADD CONSTRAINT "anchors_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchors" ADD CONSTRAINT "anchors_ledger_id_anchored_head_seq_anchored_head_hash_fkey" FOREIGN KEY ("ledger_id", "anchored_head_seq", "anchored_head_hash") REFERENCES "entries"("ledger_id", "seq", "entry_hash") ON DELETE RESTRICT ON UPDATE RESTRICT;
