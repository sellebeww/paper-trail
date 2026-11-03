// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// The file picked on the ledger screen (camera or file chooser) travels to the entry form through here:
// a File cannot go in the URL, and keeping the first tap on the system picker is what makes capture one-handed.
export type PendingKind = 'foto' | 'berkas';
let pending: { kind: PendingKind; file: File } | null = null;

export const setPending = (kind: PendingKind, file: File) => {
  pending = { kind, file };
};
/** Non-destructive, so React StrictMode's double render cannot lose the file. */
export const peekPending = (kind: PendingKind): File | null =>
  pending?.kind === kind ? pending.file : null;
export const clearPending = () => {
  pending = null;
};
