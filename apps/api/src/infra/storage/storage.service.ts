import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Global, Injectable, Module } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { AppConfig } from '../../config/config';

/**
 * Application-managed files (CSV uploads, generated reports). Local disk for development and
 * single-host deployments; any S3-compatible bucket in production. Keys are generated server-side.
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client | null;
  private readonly root: string;

  constructor(private readonly config: AppConfig) {
    this.root = resolve(config.env.STORAGE_DIR);
    this.s3 =
      config.env.STORAGE_DRIVER === 's3'
        ? new S3Client({
            region: config.env.S3_REGION || 'ap-south-1',
            endpoint: config.env.S3_ENDPOINT || undefined,
            forcePathStyle: config.env.S3_FORCE_PATH_STYLE,
          })
        : null;
  }

  private localPath(key: string): string {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.config.env.S3_BUCKET, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
      return;
    }
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    if (this.s3) {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.config.env.S3_BUCKET, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) throw new Error('Empty object');
      return Buffer.from(bytes);
    }
    return readFile(this.localPath(key));
  }

  async delete(key: string): Promise<void> {
    if (this.s3) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.env.S3_BUCKET, Key: key }));
      return;
    }
    await rm(this.localPath(key), { force: true });
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
