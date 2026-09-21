import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MinimaxService } from '../minimax/minimax.service';
import { GeminiService } from '../gemini/gemini.service';
import {
  ImageProvider,
  ImageProviderId,
  isImageProviderId,
} from './image-provider.interface';

@Injectable()
export class ImageProviderRegistry {
  private readonly logger = new Logger(ImageProviderRegistry.name);
  private readonly providers: ImageProvider[];

  constructor(minimax: MinimaxService, gemini: GeminiService) {
    this.providers = [minimax, gemini];
  }

  list(): ImageProvider[] {
    return this.providers;
  }

  available(): ImageProvider[] {
    return this.providers.filter((p) => p.isConfigured);
  }

  get(id: ImageProviderId): ImageProvider {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw new BadRequestException(`Unknown image provider "${id}"`);
    return provider;
  }

  /** The provider named by IMAGE_PROVIDER, else the first one with a key. */
  defaultProvider(): ImageProvider {
    const preferred = process.env.IMAGE_PROVIDER?.trim();

    if (preferred && isImageProviderId(preferred)) {
      const provider = this.get(preferred);
      if (provider.isConfigured) return provider;
      this.logger.warn(
        `IMAGE_PROVIDER is "${preferred}" but it has no API key; falling back`,
      );
    }

    const available = this.available();
    if (!available.length) {
      throw new BadRequestException(
        'No image provider is configured. Add MINIMAX_API_KEY or GEMINI_API_KEY to the backend .env file.',
      );
    }
    return available[0];
  }

  resolve(requested?: string): ImageProvider {
    if (requested) {
      if (!isImageProviderId(requested)) {
        throw new BadRequestException(`Unknown image provider "${requested}"`);
      }
      const provider = this.get(requested);
      if (!provider.isConfigured) {
        throw new BadRequestException(
          `${provider.label} is not configured. Add its API key to the backend .env file.`,
        );
      }
      return provider;
    }
    return this.defaultProvider();
  }
}
