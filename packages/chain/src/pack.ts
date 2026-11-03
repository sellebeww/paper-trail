// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { GENESIS_PREV_HASH } from './entry.js';
import { sha256Hex } from './hash.js';
import { canonicalize } from './jcs.js';
import {
  PACK_FORMAT_VERSION,
  type AnchorRecord,
  type Entry,
  type EvidencePack,
  type Hex,
  type PayloadObject,
  type WitnessCosignPayload,
  type WitnessSummary,
} from './types.js';
import { buildWitnessMessage } from './witness-message.js';

/** SHA-256 of JCS(pack without `pack_hash`) (SPEC §6.3). Key order and whitespace do not matter. */
export const computePackHash = (pack: Omit<EvidencePack, 'pack_hash'> | EvidencePack): Hex => {
  const rest: Partial<EvidencePack> = { ...(pack as EvidencePack) };
  delete rest.pack_hash;
  return sha256Hex(canonicalize(rest));
};

/** The reader-friendly summary of a disclosed cosign entry (SPEC §6). */
export const summarizeWitness = (entry: Entry): WitnessSummary | null => {
  if (entry.type !== 'witness_cosign' || entry.payload === undefined) return null;
  const p = entry.payload as unknown as WitnessCosignPayload;
  const { signature, ...unsigned } = p;
  return {
    entry_seq: entry.seq,
    target_seq: p.target_seq,
    witness_name: p.witness_name,
    alg: p.alg,
    witness_pub: p.witness_pub,
    signature,
    signed_message: canonicalize(buildWitnessMessage(entry.ledger_id, unsigned)),
  };
};

export interface BuildPackInput {
  generatedAt: string;
  generator: { name: string; version: string };
  ledger: { id: string; title?: string; category?: string };
  /** A contiguous run of entries, each with its payload; the builder removes what is not disclosed. */
  entries: readonly Entry[];
  /** Entries after this seq are bridge entries: envelope only, never a payload. */
  requestedToSeq: number;
  ledgerHeadSeq: number;
  /** Which payloads to disclose: everything up to `requestedToSeq`, none, or an explicit list of seqs. */
  payloads: 'all' | 'none' | readonly number[];
  /** Anchors of this ledger; only those whose head lies inside the pack are kept. */
  anchors: readonly AnchorRecord[];
  /** SHA-256 of files shipped next to the pack (zip). Only files of disclosed entries are listed. */
  filesIncluded?: readonly Hex[];
}

/** Builds a v1.0 evidence pack (pure: no I/O). Partial exports are supported (SPEC §6.2). */
export const buildEvidencePack = (input: BuildPackInput): EvidencePack => {
  const { entries } = input;
  const first = entries[0];
  const last = entries.at(-1);
  if (!first || !last) throw new Error('an evidence pack needs at least one entry');

  const wanted =
    input.payloads === 'all' ? null : new Set(input.payloads === 'none' ? [] : input.payloads);
  const disclosed = (e: Entry) =>
    e.seq <= input.requestedToSeq &&
    e.payload !== undefined &&
    (wanted === null || wanted.has(e.seq));

  const packEntries: Entry[] = entries.map((e) => {
    const out: Entry = {
      v: e.v,
      ledger_id: e.ledger_id,
      seq: e.seq,
      type: e.type,
      created_at: e.created_at,
      author_ref: e.author_ref,
      payload_hash: e.payload_hash,
      prev_hash: e.prev_hash,
      entry_hash: e.entry_hash,
    };
    if (disclosed(e)) out.payload = e.payload as PayloadObject;
    return out;
  });

  const payloadsIncluded = packEntries.filter((e) => e.payload !== undefined).map((e) => e.seq);
  const filesWanted = new Set(input.filesIncluded ?? []);
  const filesIncluded = [
    ...new Set(
      packEntries
        .filter((e) => e.payload !== undefined && (e.type === 'photo' || e.type === 'file'))
        .map((e) => (e.payload as { content_sha256: string }).content_sha256)
        .filter((sha) => filesWanted.has(sha)),
    ),
  ].sort();

  const anchors = input.anchors
    .filter((a) => a.head_seq >= first.seq && a.head_seq <= last.seq)
    .sort((a, b) => a.head_seq - b.head_seq);

  const pack: Omit<EvidencePack, 'pack_hash'> = {
    format_version: PACK_FORMAT_VERSION,
    generated_at: input.generatedAt,
    generator: input.generator,
    ledger: {
      id: input.ledger.id,
      ...(input.ledger.title !== undefined ? { title: input.ledger.title } : {}),
      ...(input.ledger.category !== undefined ? { category: input.ledger.category } : {}),
    },
    scope: {
      from_seq: first.seq,
      to_seq: last.seq,
      first_prev_hash: first.seq === 0 ? GENESIS_PREV_HASH : first.prev_hash,
      requested_to_seq: Math.min(input.requestedToSeq, last.seq),
      ledger_head_seq: input.ledgerHeadSeq,
    },
    head: { seq: last.seq, hash: last.entry_hash },
    entries: packEntries,
    witnesses: packEntries.map(summarizeWitness).filter((w): w is WitnessSummary => w !== null),
    anchors,
    disclosure: { payloads_included: payloadsIncluded, files_included: filesIncluded },
  };
  return { ...pack, pack_hash: computePackHash(pack) };
};
