import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { httpRequestRaw } from '../common/http.util';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly root = join(process.cwd(), 'uploads');

  constructor(private readonly config: ConfigService) {}

  private get publicUrl(): string {
    return (
      this.config.get<string>('PUBLIC_URL') ??
      `http://localhost:${this.config.get<string>('PORT') ?? 4100}`
    ).replace(/\/+$/, '');
  }

  /**
   * MiniMax image URLs expire after 24 hours, so every generated asset is copied
   * into local storage and re-served from this API.
   */
  async saveRemoteImage(remoteUrl: string, blogId: string): Promise<string> {
    const res = await httpRequestRaw(remoteUrl, { timeoutMs: 120_000 });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Failed to download generated image (HTTP ${res.status})`);
    }

    const contentType = String(res.headers['content-type'] ?? 'image/jpeg')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const extension = MIME_EXTENSIONS[contentType] ?? 'jpg';

    const dir = join(this.root, blogId);
    await fs.mkdir(dir, { recursive: true });

    const filename = `${randomUUID()}.${extension}`;
    await fs.writeFile(join(dir, filename), res.body);

    return `${this.publicUrl}/uploads/${blogId}/${filename}`;
  }

  async removeBlogAssets(blogId: string): Promise<void> {
    try {
      await fs.rm(join(this.root, blogId), { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`Could not remove assets for ${blogId}: ${(err as Error).message}`);
    }
  }
}
