-- Copyright (c) 2026 Vassel Goleyu. All rights reserved.
-- Hand-written: database-level integrity for the hash chain (docs/SPEC.md, docs/THREAT_MODEL.md §3.1, §4).
-- These guards hold even if application code is wrong. A database superuser can still disable
-- triggers; that residual risk is covered by external anchors, not by the database.

---------------------------------------------------------------------------------------------------
-- 1. Format checks
---------------------------------------------------------------------------------------------------

ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase" CHECK (email = lower(email));

ALTER TABLE "ledgers"
  ADD CONSTRAINT "ledgers_head_hash_hex" CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "ledgers_head_seq_nonneg" CHECK (head_seq >= 0),
  ADD CONSTRAINT "ledgers_head_pair" CHECK ((head_seq IS NULL) = (head_hash IS NULL));

ALTER TABLE "entries"
  ADD CONSTRAINT "entries_seq_nonneg" CHECK (seq >= 0),
  ADD CONSTRAINT "entries_payload_hash_hex" CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "entries_prev_hash_hex" CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "entries_entry_hash_hex" CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "entries_genesis" CHECK ((seq = 0) = (prev_hash = repeat('0', 64))),
  ADD CONSTRAINT "entries_genesis_not_cosign" CHECK (seq > 0 OR type <> 'witness_cosign'),
  ADD CONSTRAINT "entries_author_ref" CHECK (author_ref ~ '^(owner|witness):[0-9a-f-]{1,128}$'),
  ADD CONSTRAINT "entries_payload_object" CHECK (jsonb_typeof(payload) = 'object');

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_sha256_hex" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "attachments_size_positive" CHECK (size_bytes > 0);

ALTER TABLE "witness_invites"
  ADD CONSTRAINT "witness_invites_token_hash_hex" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "witness_invites_expiry_after_creation" CHECK (expires_at > created_at);

ALTER TABLE "anchors"
  ADD CONSTRAINT "anchors_head_hash_hex" CHECK (anchored_head_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "anchors_digest_hex" CHECK (anchor_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "anchors_attempts_nonneg" CHECK (attempts >= 0),
  ADD CONSTRAINT "anchors_ok_has_token" CHECK (status <> 'ok' OR (tst_token IS NOT NULL AND tst_gen_time IS NOT NULL));

---------------------------------------------------------------------------------------------------
-- 2. Append-only tables: entries, attachments, witnesses
---------------------------------------------------------------------------------------------------

CREATE FUNCTION pt_reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'paper_trail: % on "%" is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001', HINT = 'Append a new entry instead of changing or removing an old one.';
END;
$$;

CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON "entries"
  FOR EACH ROW EXECUTE FUNCTION pt_reject_modification();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON "entries"
  FOR EACH STATEMENT EXECUTE FUNCTION pt_reject_modification();

CREATE TRIGGER attachments_append_only BEFORE UPDATE OR DELETE ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION pt_reject_modification();
CREATE TRIGGER attachments_no_truncate BEFORE TRUNCATE ON "attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION pt_reject_modification();

-- Witness rows are created at signing time, so "frozen after signed" means the whole table.
CREATE TRIGGER witnesses_append_only BEFORE UPDATE OR DELETE ON "witnesses"
  FOR EACH ROW EXECUTE FUNCTION pt_reject_modification();
CREATE TRIGGER witnesses_no_truncate BEFORE TRUNCATE ON "witnesses"
  FOR EACH STATEMENT EXECUTE FUNCTION pt_reject_modification();

---------------------------------------------------------------------------------------------------
-- 3. Chain link check on insert: a new entry must extend the existing chain.
--    With UNIQUE(ledger_id, seq) this makes gaps and forks impossible even outside appendEntry.
---------------------------------------------------------------------------------------------------

CREATE FUNCTION pt_entries_check_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev_entry_hash char(64);
  prev_created_at timestamptz;
BEGIN
  IF NEW.seq = 0 THEN
    RETURN NEW;  -- genesis prev_hash is enforced by the entries_genesis CHECK
  END IF;

  SELECT entry_hash, created_at INTO prev_entry_hash, prev_created_at
    FROM "entries" WHERE ledger_id = NEW.ledger_id AND seq = NEW.seq - 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'paper_trail: entry seq % in ledger % has no predecessor (seq %)', NEW.seq, NEW.ledger_id, NEW.seq - 1
      USING ERRCODE = 'P0001';
  END IF;
  IF prev_entry_hash <> NEW.prev_hash THEN
    RAISE EXCEPTION 'paper_trail: prev_hash of seq % does not match entry_hash of seq % in ledger %', NEW.seq, NEW.seq - 1, NEW.ledger_id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_at < prev_created_at THEN
    RAISE EXCEPTION 'paper_trail: created_at of seq % is earlier than seq % in ledger %', NEW.seq, NEW.seq - 1, NEW.ledger_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entries_check_link BEFORE INSERT ON "entries"
  FOR EACH ROW EXECUTE FUNCTION pt_entries_check_link();

---------------------------------------------------------------------------------------------------
-- 4. Ledger head: may only advance by exactly one, to an entry that exists. id/owner are fixed.
---------------------------------------------------------------------------------------------------

CREATE FUNCTION pt_ledgers_guard_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id THEN
    RAISE EXCEPTION 'paper_trail: ledger id and owner cannot change' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.head_seq IS DISTINCT FROM OLD.head_seq OR NEW.head_hash IS DISTINCT FROM OLD.head_hash THEN
    IF NEW.head_seq IS NULL OR NEW.head_seq <> COALESCE(OLD.head_seq, -1) + 1 THEN
      RAISE EXCEPTION 'paper_trail: ledger % head can only advance by one (from % to %)', NEW.id, OLD.head_seq, NEW.head_seq
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "entries" WHERE ledger_id = NEW.id AND seq = NEW.head_seq AND entry_hash = NEW.head_hash
    ) THEN
      RAISE EXCEPTION 'paper_trail: ledger % head must point to an existing entry', NEW.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledgers_guard_head BEFORE UPDATE ON "ledgers"
  FOR EACH ROW EXECUTE FUNCTION pt_ledgers_guard_head();

---------------------------------------------------------------------------------------------------
-- 5. Anchors: what was anchored never changes; a successful anchor is frozen; nothing is deleted.
---------------------------------------------------------------------------------------------------

CREATE FUNCTION pt_anchors_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ledger_id <> OLD.ledger_id
     OR NEW.anchored_head_seq <> OLD.anchored_head_seq
     OR NEW.anchored_head_hash <> OLD.anchored_head_hash
     OR NEW.anchor_digest <> OLD.anchor_digest
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'paper_trail: anchored head of anchor % cannot change', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'ok' THEN
    RAISE EXCEPTION 'paper_trail: anchor % is complete and cannot change', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER anchors_guard BEFORE UPDATE ON "anchors"
  FOR EACH ROW EXECUTE FUNCTION pt_anchors_guard();
CREATE TRIGGER anchors_no_delete BEFORE DELETE ON "anchors"
  FOR EACH ROW EXECUTE FUNCTION pt_reject_modification();
CREATE TRIGGER anchors_no_truncate BEFORE TRUNCATE ON "anchors"
  FOR EACH STATEMENT EXECUTE FUNCTION pt_reject_modification();

---------------------------------------------------------------------------------------------------
-- 6. Witness invites: the link identity is fixed; used_at / revoked_at can be set once.
---------------------------------------------------------------------------------------------------

CREATE FUNCTION pt_witness_invites_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_hash <> OLD.token_hash
     OR NEW.ledger_id <> OLD.ledger_id
     OR NEW.target_entry_id <> OLD.target_entry_id
     OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'paper_trail: witness invite % cannot be re-targeted', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
    RAISE EXCEPTION 'paper_trail: witness invite % was already used', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'paper_trail: witness invite % was already revoked', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER witness_invites_guard BEFORE UPDATE ON "witness_invites"
  FOR EACH ROW EXECUTE FUNCTION pt_witness_invites_guard();
