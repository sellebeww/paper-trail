// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// Shared types for the formats in docs/SPEC.md. Field names are snake_case because they are hashed.

/** 64-character lowercase hex SHA-256. */
export type Hex = string;

/** `YYYY-MM-DDTHH:mm:ss.sssZ`, server-assigned. */
export type Timestamp = string;

export const ENTRY_TYPES = ['note', 'photo', 'file', 'witness_cosign'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** JSON allowed inside hashed payloads: no null, no floats (SPEC §1). */
export type PayloadValue = string | number | boolean | PayloadValue[] | PayloadObject;
export type PayloadObject = { [key: string]: PayloadValue };

/** The hashed part of an entry (SPEC §2.1). */
export interface EntryEnvelope {
  v: 1;
  ledger_id: string;
  seq: number;
  type: EntryType;
  created_at: Timestamp;
  author_ref: string;
  payload_hash: Hex;
  prev_hash: Hex;
}

/** A stored or exported entry. `payload` is absent when not disclosed (SPEC §6). */
export interface Entry extends EntryEnvelope {
  entry_hash: Hex;
  payload?: PayloadObject;
}

export interface NotePayload {
  text: string;
}

export interface PhotoPayload {
  content_sha256: Hex;
  size: number;
  media_type: string;
  caption?: string;
}

export interface FilePayload {
  content_sha256: Hex;
  size: number;
  media_type: string;
  name: string;
}

/** Ed25519 preferred; ES256 (ECDSA P-256 + SHA-256) where the browser lacks Ed25519 (SPEC §4.1). */
export type WitnessAlg = 'Ed25519' | 'ES256';

/** Payload of a `witness_cosign` entry (SPEC §4.2). Every field except `signature` is signed. */
export interface WitnessCosignPayload {
  invite_id: string;
  target_seq: number;
  target_entry_hash: Hex;
  statement: 'confirm';
  witness_name: string;
  /** Raw public key, base64url: 32 bytes (Ed25519) or 65-byte uncompressed point (ES256). */
  witness_pub: string;
  alg: WitnessAlg;
  /** The witness device's clock. A claim, never evidence time; the entry's created_at is. */
  signed_client_time: Timestamp;
  /** 64 bytes, base64url: Ed25519 signature, or ES256 r||s. */
  signature: string;
}

/** What the witness's browser signs: JCS of this object (SPEC §4.1). */
export interface WitnessMessage extends Omit<WitnessCosignPayload, 'signature'> {
  v: 1;
  purpose: 'papertrail.witness.cosign.v1';
  ledger_id: string;
}

/** An RFC 3161 anchor as exported (SPEC §5.2). */
export interface AnchorRecord {
  v: 1;
  ledger_id: string;
  head_seq: number;
  head_hash: Hex;
  /** Equal to head_hash (SPEC §5.1). */
  anchor_digest: Hex;
  tsa_label: string;
  /** TimeStampToken, DER, base64url. */
  tst: string;
  /** Certificates found in the token, DER base64url. Informational; the token itself is authoritative. */
  certs: string[];
  /** genTime as read from the token when exported. Informational; verifiers read it from `tst`. */
  gen_time: Timestamp;
}

export const PACK_FORMAT_VERSION = '1.0';

/** One witness signature, summarised for readers (SPEC §6). Derived from a disclosed cosign entry. */
export interface WitnessSummary {
  entry_seq: number;
  target_seq: number;
  witness_name: string;
  alg: WitnessAlg;
  witness_pub: string;
  signature: string;
  /** JCS of the signed message (SPEC §4.1), exactly the string that was signed. */
  signed_message: string;
}

export interface PackScope {
  /** First and last entry in `entries`. */
  from_seq: number;
  to_seq: number;
  /** `prev_hash` of entry `from_seq`: 64 zeros when `from_seq` is 0. An unproven claim otherwise (SPEC §6.2). */
  first_prev_hash: Hex;
  /** Last entry whose payload the owner chose to cover; entries after it are envelope-only bridge entries. */
  requested_to_seq: number;
  /** The ledger's head when the pack was made. Informational. */
  ledger_head_seq: number;
}

/** Evidence pack v1.0 (SPEC §6). */
export interface EvidencePack {
  format_version: typeof PACK_FORMAT_VERSION;
  generated_at: Timestamp;
  generator: { name: string; version: string };
  ledger: { id: string; title?: string; category?: string };
  scope: PackScope;
  /** The last entry in `entries`. */
  head: { seq: number; hash: Hex };
  entries: Entry[];
  witnesses: WitnessSummary[];
  anchors: AnchorRecord[];
  disclosure: { payloads_included: number[]; files_included: Hex[] };
  /** SHA-256 of JCS(pack without this field). A checksum and identifier, not a signature (SPEC §6.3). */
  pack_hash: Hex;
}
