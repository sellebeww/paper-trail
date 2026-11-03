// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { buildWitnessMessage, canonicalize, type WitnessAlg } from '@paper-trail/chain/browser';

export const toB64url = (bytes: ArrayBuffer | Uint8Array): string => {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export interface WitnessKey {
  alg: WitnessAlg;
  /** Raw public key, base64url. */
  publicKey: string;
  /** Non-extractable: it can sign in this tab and can never be read out or sent anywhere. */
  privateKey: CryptoKey;
}

/** Ed25519 where the browser supports it, otherwise ECDSA P-256 (SPEC §4.1). */
export const createWitnessKey = async (
  subtle: SubtleCrypto = crypto.subtle,
): Promise<WitnessKey> => {
  try {
    const pair = (await subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    return {
      alg: 'Ed25519',
      publicKey: toB64url(await subtle.exportKey('raw', pair.publicKey)),
      privateKey: pair.privateKey,
    };
  } catch {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    return {
      alg: 'ES256',
      publicKey: toB64url(await subtle.exportKey('raw', pair.publicKey)),
      privateKey: pair.privateKey,
    };
  }
};

export interface InviteInfo {
  invite: { id: string; expires_at: string; owner_display_name: string | null };
  entry: {
    ledger_id: string;
    seq: number;
    type: 'note' | 'photo' | 'file';
    created_at: string;
    entry_hash: string;
    payload: {
      text?: string;
      caption?: string;
      name?: string;
      media_type?: string;
      size?: number;
      content_sha256?: string;
    };
    has_attachment: boolean;
  };
}

/** Normalizes the name exactly as it will be signed and stored (NFC, trimmed). */
export const normalizeName = (name: string) => name.normalize('NFC').trim();

/** Signs JCS(message) for this invite (SPEC §4.1). Returns the body for POST /witness/:token/sign. */
export const signInvite = async (
  info: InviteInfo,
  name: string,
  key: WitnessKey,
  now: Date = new Date(),
  subtle: SubtleCrypto = crypto.subtle,
) => {
  const witness_name = normalizeName(name);
  const signed_client_time = now.toISOString();
  const message = buildWitnessMessage(info.entry.ledger_id, {
    invite_id: info.invite.id,
    target_seq: info.entry.seq,
    target_entry_hash: info.entry.entry_hash,
    statement: 'confirm',
    witness_name,
    witness_pub: key.publicKey,
    alg: key.alg,
    signed_client_time,
  });
  const data = new TextEncoder().encode(canonicalize(message));
  const params = key.alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
  // WebCrypto ECDSA already returns raw r||s (64 bytes), the encoding SPEC §4.1 requires.
  const signature = await subtle.sign(params, key.privateKey, data);
  return {
    alg: key.alg,
    witness_pub: key.publicKey,
    signature: toB64url(signature),
    witness_name,
    signed_client_time,
  };
};
