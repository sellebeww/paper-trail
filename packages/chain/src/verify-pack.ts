// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { canonicalEnvelope, GENESIS_PREV_HASH, HEX64, isTimestamp } from './entry.js';
import { sha256Hex } from './hash.js';
import { computePackHash, summarizeWitness } from './pack.js';
import { PACK_FORMAT_VERSION, type AnchorRecord, type Entry, type EvidencePack } from './types.js';
import { verifyChain } from './verify.js';

export type FindingCode =
  | 'CHAIN_OK'
  | 'PACK_MALFORMED'
  | 'FORMAT_UNSUPPORTED'
  | 'PACK_HASH_MISMATCH'
  | 'SCOPE_INVALID'
  | 'GENESIS_INVALID'
  | 'SEQ_GAP'
  | 'LEDGER_MISMATCH'
  | 'BROKEN_AT_SEQ'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'TIME_REGRESSION'
  | 'HEAD_MISMATCH'
  | 'WITNESS_SIG_INVALID'
  | 'WITNESS_TARGET_MISMATCH'
  | 'WITNESS_SUMMARY_MISMATCH'
  | 'ANCHOR_INVALID'
  | 'ANCHOR_TIME_CONFLICT'
  | 'FILE_HASH_MISMATCH'
  | 'FILE_MISSING'
  | 'PARTIAL_PACK'
  | 'NO_ANCHOR'
  | 'UNANCHORED_TAIL'
  | 'ANCHOR_UNVERIFIED';

export type AnchorReason =
  | 'DIGEST_MISMATCH'
  | 'HEAD_MISMATCH'
  | 'IMPRINT_MISMATCH'
  | 'TOKEN_MALFORMED'
  | 'SIGNATURE_INVALID'
  | 'CERT_UNTRUSTED';

export interface Finding {
  code: FindingCode;
  severity: 'info' | 'warning' | 'error';
  /** Entry position, or anchor head_seq for anchor findings. */
  seq?: number;
  /** For ANCHOR_INVALID: why. */
  reason?: AnchorReason;
  detail: string;
}

export interface PackVerification {
  verdict: 'OK' | 'FAILED';
  findings: Finding[];
  summary: {
    entries: number;
    from_seq: number | null;
    to_seq: number | null;
    /** True when the pack starts at seq 0. */
    from_genesis: boolean;
    chain_intact: boolean;
    witnesses_verified: number;
    anchors_verified: number;
    /** Highest entry covered by a verified anchor, or null. */
    anchored_through_seq: number | null;
  };
}

/** Result of checking one anchor's RFC 3161 token (done by packages/verifier, which owns the CMS code). */
export type AnchorTokenResult =
  | { ok: true; genTime: Date; accuracyMs: number; chainVerified: boolean }
  | { ok: false; reason: AnchorReason; detail: string };

export interface VerifyPackOptions {
  /** Cryptographically checks an anchor token against the head entry it claims to cover. */
  checkAnchorToken?: (anchor: AnchorRecord, headEntry: Entry) => Promise<AnchorTokenResult>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Verifies an evidence pack (SPEC §8). Pure and offline. Token cryptography is injected through
 * `checkAnchorToken`; without it anchors are only checked structurally and reported as unverified.
 */
export const verifyPack = async (
  input: unknown,
  options: VerifyPackOptions = {},
): Promise<PackVerification> => {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const summary: PackVerification['summary'] = {
    entries: 0,
    from_seq: null,
    to_seq: null,
    from_genesis: false,
    chain_intact: false,
    witnesses_verified: 0,
    anchors_verified: 0,
    anchored_through_seq: null,
  };
  const done = (): PackVerification => ({
    verdict: findings.some((f) => f.severity === 'error') ? 'FAILED' : 'OK',
    findings,
    summary,
  });
  const malformed = (detail: string) => {
    add({ code: 'PACK_MALFORMED', severity: 'error', detail });
    return done();
  };

  // 1. Shape and version
  if (!isObject(input)) return malformed('pack is not a JSON object');
  if (input['format_version'] !== PACK_FORMAT_VERSION) {
    add({
      code: 'FORMAT_UNSUPPORTED',
      severity: 'error',
      detail: `format_version ${String(input['format_version'])} is not supported`,
    });
    return done();
  }
  const { entries, scope, head, ledger, anchors, witnesses, disclosure, pack_hash } =
    input as Record<string, unknown>;
  if (!Array.isArray(entries) || entries.length === 0)
    return malformed('entries must be a non-empty array');
  if (!isObject(scope) || !isObject(head) || !isObject(ledger) || !isObject(disclosure))
    return malformed('scope, head, ledger and disclosure must be objects');
  if (!Array.isArray(anchors) || !Array.isArray(witnesses))
    return malformed('anchors and witnesses must be arrays');
  if (typeof pack_hash !== 'string' || !HEX64.test(pack_hash))
    return malformed('pack_hash must be 64 lowercase hex characters');
  if (typeof input['generated_at'] !== 'string' || !isTimestamp(input['generated_at']))
    return malformed('generated_at is not a valid timestamp');
  const chain = entries as Entry[];
  const pack = input as unknown as EvidencePack;
  summary.entries = chain.length;

  // 2. Pack checksum (does not stop the other checks: they say what is actually wrong)
  let computed: string;
  try {
    computed = computePackHash(pack);
  } catch (err) {
    return malformed(`pack cannot be canonicalized: ${(err as Error).message}`);
  }
  if (computed !== pack_hash) {
    add({
      code: 'PACK_HASH_MISMATCH',
      severity: 'error',
      detail: 'pack_hash does not match the pack contents',
    });
  }

  // 3. Scope and head
  const fromSeq = scope['from_seq'];
  const toSeq = scope['to_seq'];
  const firstPrev = scope['first_prev_hash'];
  const scopeOk =
    Number.isSafeInteger(fromSeq) &&
    (fromSeq as number) >= 0 &&
    toSeq === (fromSeq as number) + chain.length - 1 &&
    typeof firstPrev === 'string' &&
    HEX64.test(firstPrev) &&
    Number.isSafeInteger(scope['requested_to_seq']) &&
    (scope['requested_to_seq'] as number) >= (fromSeq as number) &&
    (scope['requested_to_seq'] as number) <= (toSeq as number) &&
    Number.isSafeInteger(scope['ledger_head_seq']) &&
    (scope['ledger_head_seq'] as number) >= (toSeq as number);
  if (!scopeOk) {
    add({ code: 'SCOPE_INVALID', severity: 'error', detail: 'scope is inconsistent with entries' });
    return done();
  }
  const from = fromSeq as number;
  const to = toSeq as number;
  summary.from_seq = from;
  summary.to_seq = to;
  summary.from_genesis = from === 0;
  if (from === 0 && firstPrev !== GENESIS_PREV_HASH) {
    add({
      code: 'SCOPE_INVALID',
      severity: 'error',
      detail: 'a pack starting at seq 0 must have an all-zero first_prev_hash',
    });
  }

  // 4. Chain segment (includes payload hashes and witness signatures)
  const result = await verifyChain(chain, {
    segment: { fromSeq: from, firstPrevHash: firstPrev as string },
  });
  if (!result.ok) {
    add({ code: result.code, severity: 'error', seq: result.brokenAtSeq, detail: result.details });
    return done(); // nothing below can be trusted once the chain is broken
  }
  summary.chain_intact = true;
  add({
    code: 'CHAIN_OK',
    severity: 'info',
    detail: `${result.length} entries intact (seq ${from}–${to})`,
  });
  for (const note of result.notes)
    add({ code: 'WITNESS_TARGET_MISMATCH', severity: 'info', detail: note });

  const last = chain[chain.length - 1]!;
  if (head['seq'] !== last.seq || head['hash'] !== last.entry_hash) {
    add({ code: 'HEAD_MISMATCH', severity: 'error', detail: 'head does not match the last entry' });
  }
  if (!ledger['id'] || chain.some((e) => e.ledger_id !== ledger['id'])) {
    add({
      code: 'LEDGER_MISMATCH',
      severity: 'error',
      detail: 'ledger.id differs from the entries’ ledger_id',
    });
  }
  if (from > 0 || scope['ledger_head_seq'] !== to) {
    add({
      code: 'PARTIAL_PACK',
      severity: 'warning',
      detail:
        (from > 0
          ? `starts at entry ${from}; earlier entries are not included and first_prev_hash is unproven. `
          : '') +
        (scope['ledger_head_seq'] !== to
          ? `ends at entry ${to}; the ledger had entries up to ${String(scope['ledger_head_seq'])} when exported.`
          : ''),
    });
  }

  // 5. Disclosure bookkeeping
  const withPayload = chain.filter((e) => e.payload !== undefined).map((e) => e.seq);
  const listed = disclosure['payloads_included'];
  if (
    !Array.isArray(listed) ||
    listed.length !== withPayload.length ||
    listed.some((s, i) => s !== withPayload[i])
  ) {
    add({
      code: 'PACK_MALFORMED',
      severity: 'error',
      detail: 'disclosure.payloads_included does not match the entries that carry a payload',
    });
  }
  const bridged = chain.filter(
    (e) => e.seq > (scope['requested_to_seq'] as number) && e.payload !== undefined,
  );
  if (bridged.length)
    add({
      code: 'PACK_MALFORMED',
      severity: 'error',
      seq: bridged[0]!.seq,
      detail: 'bridge entries must not carry a payload',
    });

  // 6. Witness summaries must say exactly what the cosign entries say
  const expectedWitnesses = chain.map(summarizeWitness).filter((w) => w !== null);
  if (canonicalJson(witnesses) !== canonicalJson(expectedWitnesses)) {
    add({
      code: 'WITNESS_SUMMARY_MISMATCH',
      severity: 'error',
      detail: 'witnesses[] does not match the disclosed witness_cosign entries',
    });
  } else {
    summary.witnesses_verified = expectedWitnesses.length; // signatures were verified inside verifyChain
  }

  // 7. Anchors
  const verified: { seq: number; genTime?: Date; accuracyMs: number }[] = [];
  let unverifiedChain = false;
  let tokenChecks = 0;
  for (const raw of anchors as AnchorRecord[]) {
    const seq = isObject(raw) && Number.isSafeInteger(raw.head_seq) ? raw.head_seq : -1;
    const bad = (reason: AnchorReason, detail: string) =>
      add({ code: 'ANCHOR_INVALID', severity: 'error', seq, reason, detail });
    const headEntry = chain[seq - from];
    if (!headEntry || seq < from || seq > to) {
      bad('HEAD_MISMATCH', 'anchor head_seq is not inside the pack');
      continue;
    }
    if (raw.head_hash !== headEntry.entry_hash || raw.ledger_id !== headEntry.ledger_id) {
      bad('HEAD_MISMATCH', 'anchor head_hash does not match the entry');
      continue;
    }
    if (raw.anchor_digest !== headEntry.entry_hash) {
      bad('DIGEST_MISMATCH', 'anchor_digest must equal head_hash');
      continue;
    }
    if (typeof raw.tst !== 'string' || raw.tst.length === 0) {
      bad('TOKEN_MALFORMED', 'anchor has no token');
      continue;
    }

    if (!options.checkAnchorToken) {
      verified.push({ seq, accuracyMs: 0 });
      continue;
    }
    tokenChecks++;
    const r = await options.checkAnchorToken(raw, headEntry);
    if (!r.ok) {
      bad(r.reason, r.detail);
      continue;
    }
    unverifiedChain ||= !r.chainVerified;
    verified.push({ seq, genTime: r.genTime, accuracyMs: r.accuracyMs });
  }
  summary.anchors_verified = tokenChecks > 0 ? verified.length : 0;
  if (!options.checkAnchorToken && verified.length) {
    add({
      code: 'ANCHOR_UNVERIFIED',
      severity: 'warning',
      detail: 'anchor tokens were not cryptographically checked (no token verifier was used)',
    });
  } else if (unverifiedChain) {
    add({
      code: 'ANCHOR_UNVERIFIED',
      severity: 'warning',
      detail:
        'token signatures are valid but the TSA certificate chain was not checked (no trusted roots given)',
    });
  }

  // 8. Coverage
  if (verified.length === 0) {
    add({
      code: 'NO_ANCHOR',
      severity: 'warning',
      detail:
        'no usable anchor in this pack: nothing here is proven to have existed at a particular time',
    });
  } else {
    const through = Math.max(...verified.map((v) => v.seq));
    summary.anchored_through_seq = through;
    if (through < to)
      add({
        code: 'UNANCHORED_TAIL',
        severity: 'warning',
        seq: through + 1,
        detail: `entries ${through + 1}–${to} have no external time proof`,
      });
  }

  // 9. Time bound: an entry cannot be newer than the anchor that covers it
  for (const e of chain) {
    const cover = verified
      .filter((v) => v.genTime && v.seq >= e.seq)
      .sort((a, b) => a.seq - b.seq)[0];
    if (!cover?.genTime) continue;
    if (Date.parse(e.created_at) > cover.genTime.getTime() + 1000 + cover.accuracyMs) {
      add({
        code: 'ANCHOR_TIME_CONFLICT',
        severity: 'error',
        seq: e.seq,
        detail: `created_at ${e.created_at} is later than the covering anchor's time ${cover.genTime.toISOString()}`,
      });
    }
  }
  return done();
};

// JCS is not needed to compare: both sides are produced by the same functions, so stringify with sorted keys.
const canonicalJson = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) =>
    isObject(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );

/**
 * Checks files that travel with a pack (zip) against the sha256 values the entries commit to (SPEC §6.4).
 * `files` maps a lowercase hex sha256 to the bytes found for it.
 */
export const verifyAttachments = (
  pack: EvidencePack,
  files: ReadonlyMap<string, Uint8Array>,
): Finding[] => {
  const findings: Finding[] = [];
  const wanted = new Set(pack.disclosure.files_included);
  for (const e of pack.entries) {
    if (e.payload === undefined || (e.type !== 'photo' && e.type !== 'file')) continue;
    const sha = (e.payload as { content_sha256: string }).content_sha256;
    if (!wanted.has(sha)) continue;
    const bytes = files.get(sha);
    if (!bytes)
      findings.push({
        code: 'FILE_MISSING',
        severity: 'warning',
        seq: e.seq,
        detail: `file ${sha.slice(0, 8)}… is listed but not included`,
      });
    else if (sha256Hex(bytes) !== sha)
      findings.push({
        code: 'FILE_HASH_MISMATCH',
        severity: 'error',
        seq: e.seq,
        detail: 'file content does not match content_sha256',
      });
  }
  return findings;
};

/** Recomputes the head's canonical envelope, i.e. the data an anchor timestamps (SPEC §5.1). */
export const anchorData = (headEntry: Entry): Uint8Array =>
  new TextEncoder().encode(canonicalEnvelope(headEntry));
