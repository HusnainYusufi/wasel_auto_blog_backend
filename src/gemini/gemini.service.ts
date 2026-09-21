import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatMessage, ChatOptions } from '../minimax/minimax.types';
import { extractJson } from '../common/json.util';
import { postJson } from '../common/http.util';
import { TextProvider } from '../providers/text-provider.interface';
import {
  GEMINI_IMAGE_MODELS,
  GeneratedImage,
  ImageProvider,
} from '../providers/image-provider.interface';
import { GEMINI_TEXT_MODELS, GeminiPart, GeminiResponse } from './gemini.types';

const PLACEHOLDER_KEY = 'your_gemini_api_key_here';
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);

@Injectable()
export class GeminiService implements TextProvider, ImageProvider {
  private readonly logger = new Logger(GeminiService.name);

  readonly id = 'gemini' as const;
  readonly label = 'Google Gemini';
  readonly models = GEMINI_TEXT_MODELS;

  constructor(private readonly config: ConfigService) {}

  get baseUrl(): string {
    return (
      this.config.get<string>('GEMINI_BASE_URL') ??
      'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, '');
  }

  get isConfigured(): boolean {
    const key = this.config.get<string>('GEMINI_API_KEY')?.trim();
    return Boolean(key) && key !== PLACEHOLDER_KEY;
  }

  get defaultModel(): string {
    return this.config.get<string>('GEMINI_TEXT_MODEL') ?? 'gemini-flash-latest';
  }

  get defaultImageModel(): string {
    return (
      this.config.get<string>('GEMINI_IMAGE_MODEL') ?? 'gemini-3.1-flash-image'
    );
  }

  /**
   * Text-to-image. Unlike MiniMax, Gemini returns the image inline as base64
   * rather than a URL, so the bytes are handed back directly — nothing to
   * download and nothing that expires.
   */
  async generateImage(params: {
    prompt: string;
    aspectRatio?: string;
    model?: string;
  }): Promise<GeneratedImage> {
    const model = (GEMINI_IMAGE_MODELS as readonly string[]).includes(
      params.model ?? '',
    )
      ? (params.model as string)
      : this.defaultImageModel;

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: params.prompt.slice(0, 4000) }] }],
      generationConfig: {
        ...(params.aspectRatio
          ? { imageConfig: { aspectRatio: params.aspectRatio } }
          : {}),
      },
    };

    const response = await this.request(
      `/models/${encodeURIComponent(model)}:generateContent`,
      body,
    );

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new ServiceUnavailableException(
        `Gemini refused the image prompt (${blockReason}).`,
      );
    }

    const candidate = response.candidates?.[0];

    for (const part of candidate?.content?.parts ?? []) {
      const inline = part.inlineData ?? part.inline_data;
      if (inline?.data) {
        return {
          buffer: Buffer.from(inline.data, 'base64'),
          contentType: inline.mimeType ?? inline.mime_type ?? 'image/jpeg',
        };
      }
    }

    // A text-only reply usually means the model declined the prompt.
    const explanation = extractText(candidate?.content?.parts).slice(0, 200);
    throw new ServiceUnavailableException(
      `Gemini returned no image${candidate?.finishReason ? ` (${candidate.finishReason})` : ''}${explanation ? `: ${explanation}` : ''}`,
    );
  }

  private get apiKey(): string {
    const key = this.config.get<string>('GEMINI_API_KEY')?.trim();
    if (!key || key === PLACEHOLDER_KEY) {
      throw new ServiceUnavailableException(
        'GEMINI_API_KEY is not configured. Add your key to the backend .env file and restart.',
      );
    }
    return key;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    return this.generate(messages, options, false);
  }

  /**
   * Gemini has a native JSON mode, so unlike MiniMax there is no need for a
   * corrective retry — the response is already constrained to an object.
   */
  async chatJson<T>(messages: ChatMessage[], options: ChatOptions = {}): Promise<T> {
    const raw = await this.generate(
      messages,
      { temperature: 0.6, ...options },
      true,
    );

    const parsed = extractJson<T>(raw);
    if (parsed) return parsed;

    throw new ServiceUnavailableException(
      'Gemini returned a response that could not be parsed as JSON.',
    );
  }

  private async generate(
    messages: ChatMessage[],
    options: ChatOptions,
    jsonMode: boolean,
  ): Promise<string> {
    const model = this.resolveModel(options.model);

    // Gemini takes system prompts in a dedicated field, not in `contents`.
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
      .trim();

    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    if (!contents.length) {
      // A system-only prompt would be rejected, so promote it to a user turn.
      contents.push({ role: 'user', parts: [{ text: systemText || 'Continue.' }] });
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.8,
        topP: options.topP ?? 0.95,
        maxOutputTokens: options.maxTokens ?? 8192,
        ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    };

    if (systemText && contents.length) {
      body.systemInstruction = { parts: [{ text: systemText }] };
    }

    const response = await this.request(
      `/models/${encodeURIComponent(model)}:generateContent`,
      body,
    );

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new ServiceUnavailableException(
        `Gemini blocked the prompt (${blockReason}). Try rephrasing the topic.`,
      );
    }

    const candidate = response.candidates?.[0];
    const finish = candidate?.finishReason;

    if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') {
      throw new ServiceUnavailableException(
        `Gemini stopped generating for safety reasons (${finish}).`,
      );
    }

    const text = extractText(candidate?.content?.parts);

    if (!text) {
      // MAX_TOKENS with no text means the whole budget went to reasoning.
      if (finish === 'MAX_TOKENS') {
        throw new ServiceUnavailableException(
          'Gemini hit its output limit before producing any text. Try a shorter article length or a different model.',
        );
      }
      throw new ServiceUnavailableException(
        `Gemini returned an empty completion${finish ? ` (${finish})` : ''}.`,
      );
    }

    if (finish === 'MAX_TOKENS') {
      this.logger.warn(`Gemini truncated the response for model ${model}`);
    }

    return text;
  }

  private resolveModel(requested?: string): string {
    if (!requested) return this.defaultModel;
    return (this.models as readonly string[]).includes(requested)
      ? requested
      : this.defaultModel;
  }

  private async request(
    path: string,
    body: unknown,
    attempt = 1,
  ): Promise<GeminiResponse> {
    const maxAttempts = 4;

    let res: { status: number; text: string };
    try {
      res = await postJson(`${this.baseUrl}${path}`, body, {
        // Header auth keeps the key out of URLs, request logs and error traces.
        'X-goog-api-key': this.apiKey,
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        await this.backoff(attempt);
        return this.request(path, body, attempt + 1);
      }
      throw new ServiceUnavailableException(
        `Could not reach Gemini (${(err as Error).message}).`,
      );
    }

    if (res.status < 200 || res.status >= 300) {
      if (RETRYABLE_HTTP.has(res.status) && attempt < maxAttempts) {
        this.logger.warn(
          `Gemini ${path} returned ${res.status}, retry ${attempt}/${maxAttempts}`,
        );
        await this.backoff(attempt);
        return this.request(path, body, attempt + 1);
      }

      if (res.status === 401 || res.status === 403) {
        throw new ServiceUnavailableException(
          'Gemini rejected the API key. Set a valid GEMINI_API_KEY in the backend .env and restart the server.',
        );
      }
      if (res.status === 429) {
        throw new ServiceUnavailableException(
          'Gemini rate limit or quota reached. Wait a moment and try again.',
        );
      }

      throw new ServiceUnavailableException(
        `Gemini ${path} failed with HTTP ${res.status}: ${summarizeError(res.text)}`,
      );
    }

    try {
      return JSON.parse(res.text) as GeminiResponse;
    } catch {
      throw new ServiceUnavailableException(
        `Gemini ${path} returned a non-JSON body: ${res.text.slice(0, 300)}`,
      );
    }
  }

  private backoff(attempt: number): Promise<void> {
    const delay = Math.min(1500 * 2 ** (attempt - 1), 12000);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Joins the prose parts. Reasoning parts carry `thought`/`thoughtSignature`
 * rather than answer text, so they are dropped before assembling the output.
 */
function extractText(parts?: GeminiPart[]): string {
  if (!parts?.length) return '';

  return parts
    .filter((part) => part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim();
}

function summarizeError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as GeminiResponse;
    const error = parsed.error;
    if (error) {
      return `${error.status ?? ''} ${error.message ?? ''}`.trim();
    }
  } catch {
    /* fall through to the raw body */
  }
  return raw.slice(0, 300);
}
