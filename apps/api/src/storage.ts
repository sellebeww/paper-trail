// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { Readable } from 'node:stream';
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
