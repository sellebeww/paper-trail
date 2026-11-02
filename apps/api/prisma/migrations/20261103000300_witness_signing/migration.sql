-- Copyright (c) 2026 Vassel Goleyu. All rights reserved.
-- Witness co-signing (docs/SPEC.md §4): signature algorithm per witness, owner name chosen per invite.

ALTER TABLE "witness_invites" ADD COLUMN "owner_display_name" VARCHAR(80);

-- The witnesses table is append-only and still empty when this runs, so a NOT NULL column is safe.
ALTER TABLE "witnesses" ADD COLUMN "alg" VARCHAR(10) NOT NULL;
ALTER TABLE "witnesses" ADD CONSTRAINT "witnesses_alg" CHECK (alg IN ('Ed25519', 'ES256'));

-- What the witness is shown is fixed when the invite is created: owner_display_name joins the frozen fields.
CREATE OR REPLACE FUNCTION pt_witness_invites_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_hash <> OLD.token_hash
     OR NEW.ledger_id <> OLD.ledger_id
     OR NEW.target_entry_id <> OLD.target_entry_id
     OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at
     OR NEW.owner_display_name IS DISTINCT FROM OLD.owner_display_name THEN
    RAISE EXCEPTION 'paper_trail: witness invite % cannot be re-targeted', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
    RAISE EXCEPTION 'paper_trail: witness invite % was already used', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'paper_trail: witness invite % was already revoked', OLD.id USING ERRCODE = 'P0001';
  END IF;
  -- A revoked invite can never be used, and a used invite can never be revoked.
  IF (NEW.used_at IS NOT NULL AND NEW.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'paper_trail: witness invite % cannot be both used and revoked', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
