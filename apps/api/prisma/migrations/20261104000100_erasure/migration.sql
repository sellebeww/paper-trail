-- Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
-- Owner-requested erasure (docs/OPEN_DECISIONS.md, D11): erase the CONTENT of entries, keep the skeleton.
-- The hash chain stays intact: an erased entry keeps every hashed field, so packs that include it verify with the
-- payload undisclosed (SPEC section 6). Exactly three things become possible, each only for an already erased entry:
--   1. an entry may change once, from "has a payload" to "payload = {} and erased_at set", nothing else different;
--   2. its attachment rows may be deleted;
--   3. witness rows of its co-sign may be deleted (they hold the witness name and key).
-- Everything else stays append-only. Rewriting an entry, or deleting it, is still rejected.

ALTER TABLE "entries" ADD COLUMN "erased_at" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

-- entries: DELETE is still rejected; UPDATE only for the erase transition.
DROP TRIGGER "entries_append_only" ON "entries";

CREATE TRIGGER entries_no_delete BEFORE DELETE ON "entries"
  FOR EACH ROW EXECUTE FUNCTION pt_reject_modification();

CREATE FUNCTION pt_entries_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL AND NEW.payload = '{}'::jsonb
     AND NEW.id = OLD.id AND NEW.ledger_id = OLD.ledger_id AND NEW.seq = OLD.seq AND NEW.type = OLD.type
     AND NEW.created_at = OLD.created_at AND NEW.author_ref = OLD.author_ref
     AND NEW.payload_hash = OLD.payload_hash AND NEW.prev_hash = OLD.prev_hash
     AND NEW.entry_hash = OLD.entry_hash THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'paper_trail: UPDATE on "entries" is not allowed: only erasing the payload of an entry is'
    USING ERRCODE = 'P0001', HINT = 'Append a new entry instead of changing an old one.';
END;
$$;

CREATE TRIGGER entries_guard_update BEFORE UPDATE ON "entries"
  FOR EACH ROW EXECUTE FUNCTION pt_entries_guard_update();

-- attachments and witnesses: UPDATE is still rejected; DELETE only once the entry they belong to is erased.
CREATE FUNCTION pt_delete_if_erased() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'attachments' THEN
    entry_id := OLD.entry_id;
  ELSE
    entry_id := OLD.cosign_entry_id;
  END IF;
  IF EXISTS (SELECT 1 FROM "entries" WHERE id = entry_id AND erased_at IS NOT NULL) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'paper_trail: DELETE on "%" is not allowed until its entry is erased', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER "attachments_append_only" ON "attachments";
CREATE TRIGGER attachments_no_update BEFORE UPDATE ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION pt_reject_modification();
CREATE TRIGGER attachments_delete_if_erased BEFORE DELETE ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION pt_delete_if_erased();

DROP TRIGGER "witnesses_append_only" ON "witnesses";
CREATE TRIGGER witnesses_no_update BEFORE UPDATE ON "witnesses"
  FOR EACH ROW EXECUTE FUNCTION pt_reject_modification();
CREATE TRIGGER witnesses_delete_if_erased BEFORE DELETE ON "witnesses"
  FOR EACH ROW EXECUTE FUNCTION pt_delete_if_erased();
