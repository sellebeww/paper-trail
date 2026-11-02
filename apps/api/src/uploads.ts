// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import busboy from 'busboy';
import { fileTypeFromBuffer } from 'file-type';
import { AppError } from './errors.js';
import type { ObjectStore } from './storage.js';

/**
 * Accepted content types, keyed by the type detected from the file's magic bytes.
 * The client-supplied MIME type and file extension are never used to decide anything.
 * Audio and Office formats are accepted by detection but not yet covered by tests.
 */
export const ALLOWED_TYPES: Record<string, { ext: string; image: boolean }> = {
  'image/jpeg': { ext: 'jpg', image: true },
  'image/png': { ext: 'png', image: true },
  'image/webp': { ext: 'webp', image: true },
  'image/heic': { ext: 'heic', image: true },
  'image/heif': { ext: 'heif', image: true },
  'application/pdf': { ext: 'pdf', image: false },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    ext: 'docx',
    image: false,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    ext: 'xlsx',
    image: false,
  },
  'audio/mpeg': { ext: 'mp3', image: false },
  'audio/x-m4a': { ext: 'm4a', image: false },
  'audio/mp4': { ext: 'm4a', image: false },
  'audio/ogg': { ext: 'ogg', image: false },
  'audio/opus': { ext: 'opus', image: false },
};

const SNIFF_BYTES = 4100; // file-type needs at most ~4 KB to recognise the formats above
const MULTIPART_OVERHEAD = 64 * 1024;
const MAX_FILENAME_CODE_POINTS = 120;

// Control characters, bidi overrides/isolates, zero-width characters, BOM, and path/shell-hostile punctuation.
const UNSAFE_FILENAME_CHARS = /[\p{Cc}\p{Cf}<>:"|?*\\/]/gu;

/** Makes a client-supplied file name safe to store and to put in a header. Never returns an empty string. */
export const sanitizeFilename = (raw: string | undefined): string => {
  const cleaned = (raw ?? '')
    .normalize('NFC')
    .replace(UNSAFE_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'berkas';
  const chars = Array.from(cleaned);
  if (chars.length <= MAX_FILENAME_CODE_POINTS) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return Array.from(cleaned.slice(0, dot > 0 ? dot : undefined))
    .slice(0, MAX_FILENAME_CODE_POINTS - Array.from(ext).length)
    .join('')
    .concat(ext);
};

export interface StoredUpload {
  fields: Record<string, string>;
  filename: string;
  storageKey: string;
  mime: string;
  ext: string;
  size: number;
  sha256: string;
}

const invalid = (message: string) => new AppError(400, 'INVALID_UPLOAD', message);

type StoredFile = Omit<StoredUpload, 'fields' | 'filename'>;

const storeFile = async (
  stream: NodeJS.ReadableStream,
  kind: string | undefined,
  store: ObjectStore,
  maxBytes: number,
): Promise<StoredFile> => {
  const it = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let sniffed = 0;
  while (sniffed < SNIFF_BYTES) {
    const next = await it.next();
    if (next.done) break;
    chunks.push(next.value);
    sniffed += next.value.length;
  }
  const head = Buffer.concat(chunks);
  if (head.length === 0) throw invalid('Berkas kosong.');

  const detected = await fileTypeFromBuffer(head);
  const rule = detected ? ALLOWED_TYPES[detected.mime] : undefined;
  if (!detected || !rule || (kind === 'photo' && !rule.image)) {
    throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Jenis berkas ini tidak diizinkan.');
  }

  const hash = createHash('sha256');
  let size = 0;
  let tooLarge: AppError | undefined;
  const feed = (chunk: Buffer): Buffer => {
    size += chunk.length;
    if (size > maxBytes) {
      tooLarge = new AppError(
        413,
        'FILE_TOO_LARGE',
        `Berkas terlalu besar (maksimal ${Math.floor(maxBytes / 1024 / 1024)} MB).`,
      );
      throw tooLarge;
    }
    hash.update(chunk);
    return chunk;
  };
  async function* body(): AsyncGenerator<Buffer> {
    yield feed(head);
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      yield feed(next.value);
    }
  }

  const storageKey = `u/${randomUUID()}`;
  try {
    await store.put(storageKey, Readable.from(body()), detected.mime);
  } catch (err) {
    await store.delete(storageKey).catch(() => undefined);
    if (tooLarge) throw tooLarge;
    if (err instanceof AppError) throw err;
    throw new AppError(
      503,
      'STORAGE_UNAVAILABLE',
      'Penyimpanan berkas sementara tidak tersedia. Coba lagi nanti.',
    );
  }
  return { storageKey, mime: detected.mime, ext: rule.ext, size, sha256: hash.digest('hex') };
};

/**
 * Reads a single-file multipart request. The `type` field must come before the file part.
 * The file is sniffed, hashed and stored while streaming; nothing is buffered beyond the first 4 KB.
 * If this rejects, no object is left behind. If it resolves, the caller owns the object (delete it on failure).
 */
export const readUpload = (
  req: Request,
  store: ObjectStore,
  maxBytes: number,
): Promise<StoredUpload> =>
  new Promise((resolve, reject) => {
    if (!req.is('multipart/form-data')) {
      return reject(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Gunakan multipart/form-data.'));
    }
    const declared = Number(req.headers['content-length']);
    if (declared > maxBytes + MULTIPART_OVERHEAD) {
      return reject(new AppError(413, 'FILE_TOO_LARGE', 'Berkas terlalu besar.'));
    }

    const bb = busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      limits: { files: 1, fields: 4, parts: 5, fieldSize: 2048, fieldNameSize: 50 },
    });
    const fields: Record<string, string> = {};
    let filename: string | undefined;
    let filePromise: Promise<StoredFile> | undefined;
    let failed = false;

    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      req.unpipe(bb);
      req.resume();
      // A file that finished storing after we gave up must not be left behind.
      void filePromise?.then((f) => store.delete(f.storageKey)).catch(() => undefined);
      reject(err);
    };

    bb.on('field', (name, value, info) => {
      if (info.valueTruncated) return fail(invalid('Isi kolom terlalu panjang.'));
      fields[name] = value;
    });
    bb.on('file', (name, stream, info) => {
      if (name !== 'file' || filePromise) {
        stream.resume();
        return fail(invalid('Kirim tepat satu berkas pada kolom "file".'));
      }
      if (fields['type'] !== 'photo' && fields['type'] !== 'file') {
        stream.resume();
        return fail(invalid('Kolom "type" (photo atau file) harus dikirim sebelum berkas.'));
      }
      filename = info.filename;
      filePromise = storeFile(stream, fields['type'], store, maxBytes);
      filePromise.catch(fail);
    });
    for (const event of ['partsLimit', 'filesLimit', 'fieldsLimit'] as const) {
      bb.on(event, () => fail(invalid('Permintaan tidak valid.')));
    }
    bb.on('error', () => fail(invalid('Permintaan multipart tidak valid.')));
    bb.on('close', () => {
      if (failed) return;
      if (!filePromise) return fail(invalid('Berkas tidak ditemukan pada permintaan.'));
      filePromise.then(
        (stored) => resolve({ ...stored, fields, filename: sanitizeFilename(filename) }),
        fail,
      );
    });
    req.pipe(bb);
  });
