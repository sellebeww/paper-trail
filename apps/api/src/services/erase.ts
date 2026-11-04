// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Owner-requested erasure (docs/OPEN_DECISIONS.md, D11): the CONTENT of a ledger goes, its skeleton stays.
// Entries keep every hashed field, so the chain, the anchors and any pack exported later still verify, with the
// erased payloads simply undisclosed. The database triggers (migration _erasure) allow only this one transition.
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth.js';
import type { Db } from '../db.js';
import type { ObjectStore } from '../storage.js';
import type { Tx } from './ledger.js';

export const ERASED_TITLE = '(dihapus)';

/** Everything below runs inside the caller's transaction; the returned keys are removed from storage afterwards. */
export const eraseLedgerIn = async (tx: Tx, ledgerId: string, now = new Date()) => {
  const files = await tx.attachment.findMany({
    where: { entry: { ledgerId } },
    select: { storageKey: true },
  });
  // Order matters: the triggers only allow deleting attachments and witnesses of entries that are already erased.
  const { count } = await tx.entry.updateMany({
    where: { ledgerId, erasedAt: null },
    data: { payload: {}, erasedAt: now },
  });
  await tx.attachment.deleteMany({ where: { entry: { ledgerId } } });
  await tx.witness.deleteMany({ where: { ledgerId } });
  // Unused links must stop working (they would show the erased entry); the owner's chosen display name goes too.
  await tx.witnessInvite.updateMany({
    where: { ledgerId, usedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  await tx.witnessInvite.updateMany({ where: { ledgerId }, data: { ownerDisplayName: null } });
  await tx.reminderSchedule.deleteMany({ where: { ledgerId } });
  await tx.ledger.update({ where: { id: ledgerId }, data: { title: ERASED_TITLE } });
  return { entries: count, storageKeys: files.map((f) => f.storageKey) };
};

/** Files are deleted only after the database commit, so a failure leaves orphans rather than broken entries. */
const removeFiles = async (store: ObjectStore, keys: string[]) => {
  const results = await Promise.allSettled([...new Set(keys)].map((k) => store.delete(k)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed) console.error(JSON.stringify({ msg: 'erased files left in storage', count: failed }));
};

export const eraseLedger = async (db: Db, store: ObjectStore, ledgerId: string) => {
  const done = await db.$transaction((tx) => eraseLedgerIn(tx, ledgerId));
  await removeFiles(store, done.storageKeys);
  return { entries: done.entries };
};

/**
 * Erases every ledger of the user, then replaces the account's identity. The row stays because ledgers point at it,
 * but it holds no email, no usable password and no sessions, tokens or reminders.
 */
export const eraseAccount = async (db: Db, store: ObjectStore, userId: string) => {
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url')); // nobody knows this password
  const done = await db.$transaction(async (tx) => {
    const ledgers = await tx.ledger.findMany({ where: { ownerId: userId }, select: { id: true } });
    let entries = 0;
    const storageKeys: string[] = [];
    for (const { id } of ledgers) {
      const r = await eraseLedgerIn(tx, id);
      entries += r.entries;
      storageKeys.push(...r.storageKeys);
    }
    await tx.reminderSchedule.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });
    await tx.userToken.deleteMany({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: {
        email: `deleted-${userId}@erased.invalid`,
        passwordHash,
        emailVerifiedAt: null,
        deletedAt: new Date(),
      },
    });
    return { entries, ledgers: ledgers.length, storageKeys };
  });
  await removeFiles(store, done.storageKeys);
  return { entries: done.entries, ledgers: done.ledgers };
};
