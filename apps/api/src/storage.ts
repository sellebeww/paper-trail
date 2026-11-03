// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

/** Where file bytes live. The chain only stores their SHA-256 (docs/SPEC.md §3). */
export interface ObjectStore {
  put(key: string, body: Readable, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

export interface S3StoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

/** S3-compatible store (MinIO in development). */
export class S3Store implements ObjectStore {
  private readonly client: S3Client;
  constructor(private readonly cfg: S3StoreConfig) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  }

  /** Creates the bucket if it is missing. Call once at startup. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.cfg.bucket }));
    }
  }

  async put(key: string, body: Readable, contentType: string): Promise<void> {
    await new Upload({
      client: this.client,
      params: { Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType },
    }).done();
  }

  async get(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return out.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

/**
 * Files in a local directory: no extra service to run. Keys are `u/<uuid>` made by the server, but the resolved path
 * is still checked to stay inside the root. Writes go to a temp file first, so a failed upload leaves nothing behind.
 * shortcut: single host only, no replication; use S3Store when the API runs on more than one machine.
 */
export class FsStore implements ObjectStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('invalid key');
    return p;
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async put(key: string, body: Readable): Promise<void> {
    const target = this.path(key);
    const tmp = `${target}.${process.pid}.part`;
    await mkdir(dirname(target), { recursive: true });
    try {
      await pipeline(body, createWriteStream(tmp, { flags: 'wx' }));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<Readable> {
    const stream = createReadStream(this.path(key));
    // Surface a missing file now (as S3 does), not as an error event later.
    await new Promise<void>((ok, fail) => stream.once('open', () => ok()).once('error', fail));
    return stream;
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** In-memory store for tests. */
export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();

  async put(key: string, body: Readable, contentType: string): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    this.objects.set(key, { data: Buffer.concat(chunks), contentType });
  }

  async get(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (!object) throw new Error('NoSuchKey');
    return Readable.from([object.data]);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
