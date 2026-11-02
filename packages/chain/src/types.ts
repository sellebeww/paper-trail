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

/** What the witness's browser signs (SPEC §4.1). */
export interface WitnessStatement {
  purpose: 'papertrail.witness.cosign.v1';
  ledger_id: string;
  target_seq: number;
  target_entry_hash: Hex;
  statement: 'confirm';
  witness_name?: string;
  witness_pub: string;
}

/** Payload of a `witness_cosign` entry (SPEC §4.2). */
export interface WitnessCosignPayload {
  target_seq: number;
  target_entry_hash: Hex;
  statement: 'confirm';
  witness_name?: string;
  witness_pub: string;
  signature: string;
}

/** Stored RFC 3161 anchor (SPEC §5.2). */
export interface AnchorRecord {
  v: 1;
  ledger_id: string;
  head_seq: number;
  head_hash: Hex;
  anchor_digest: Hex;
  tsa_label: string;
  tst: string;
  certs?: string[];
  requested_at: Timestamp;
}

/** Evidence pack (SPEC §6). */
export interface EvidencePack {
  format_version: '0.1';
  generated_at: Timestamp;
  generator: { name: string; version: string };
  ledger: { id: string; title?: string };
  head: { seq: number; hash: Hex };
  entries: Entry[];
  anchors: AnchorRecord[];
  disclosure: { payloads_included: number[]; files_included: Hex[] };
}
