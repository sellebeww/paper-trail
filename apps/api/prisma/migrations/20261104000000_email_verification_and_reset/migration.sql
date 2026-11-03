-- Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
-- Email verification and password reset (docs/API.md, "Authentication"). Not part of the evidence chain.
-- Tokens are random 256-bit values; only their SHA-256 is stored, and each works once until it expires.

CREATE TYPE "user_token_kind" AS ENUM ('verify_email', 'reset_password');

ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ(3);

CREATE TABLE "user_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "user_token_kind" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_tokens_token_hash_key" ON "user_tokens"("token_hash");
CREATE INDEX "user_tokens_user_id_kind_idx" ON "user_tokens"("user_id", "kind");

ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_token_hash_hex" CHECK (token_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_expiry_after_creation" CHECK (expires_at > created_at);
