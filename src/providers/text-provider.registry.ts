import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MinimaxService } from '../minimax/minimax.service';
import { GeminiService } from '../gemini/gemini.service';
import {
  TextProvider,
  TextProviderId,
  isTextProviderId,
} from './text-provider.interface';

@Injectable()
export class TextProviderRegistry {
  private readonly logger = new Logger(TextProviderRegistry.name);
  private readonly providers: TextProvider[];

  constructor(
    private readonly minimax: MinimaxService,
    private readonly gemini: GeminiService,
  ) {
    this.providers = [minimax, gemini];
  }

  /** Every provider, including ones without a key, so the UI can grey them out. */
  list(): TextProvider[] {
    return this.providers;
  }

  available(): TextProvider[] {
    return this.providers.filter((p) => p.isConfigured);
  }

  get(id: TextProviderId): TextProvider {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw new BadRequestException(`Unknown text provider "${id}"`);
    return provider;
  }

  /**
   * Resolves a generation request to a concrete provider and model.
   *
   * A stored `textModel` alone is enough to route later regenerations, because
   * model ids do not collide across providers. An explicit provider wins; a
   * model that belongs to a different provider corrects the provider rather
   * than silently substituting that provider's default model.
   */
  resolve(request: { provider?: string; model?: string }): {
    provider: TextProvider;
    model: string;
  } {
    const owner = request.model ? this.findByModel(request.model) : undefined;

    let provider: TextProvider | undefined;

    if (request.provider) {
      if (!isTextProviderId(request.provider)) {
        throw new BadRequestException(
          `Unknown text provider "${request.provider}"`,
        );
      }
      provider = this.get(request.provider);

      if (owner && owner.id !== provider.id) {
        this.logger.warn(
          `Model ${request.model} belongs to ${owner.id}, not ${provider.id}; using ${owner.id}`,
        );
        provider = owner;
      }
    } else {
      provider = owner ?? this.defaultProvider();
    }

    if (!provider.isConfigured) {
      throw new BadRequestException(
        `${provider.label} is not configured. Add its API key to the backend .env file.`,
      );
    }

    const model =
      request.model && (provider.models as readonly string[]).includes(request.model)
        ? request.model
        : provider.defaultModel;

    return { provider, model };
  }

  /** The configured provider named by TEXT_PROVIDER, else the first with a key. */
  defaultProvider(): TextProvider {
    const preferred = process.env.TEXT_PROVIDER?.trim();

    if (preferred && isTextProviderId(preferred)) {
      const provider = this.get(preferred);
      if (provider.isConfigured) return provider;
      this.logger.warn(
        `TEXT_PROVIDER is "${preferred}" but it has no API key; falling back`,
      );
    }

    const available = this.available();
    if (!available.length) {
      throw new BadRequestException(
        'No text provider is configured. Add MINIMAX_API_KEY or GEMINI_API_KEY to the backend .env file.',
      );
    }
    return available[0];
  }

  private findByModel(model: string): TextProvider | undefined {
    return this.providers.find((p) =>
      (p.models as readonly string[]).includes(model),
    );
  }
}
