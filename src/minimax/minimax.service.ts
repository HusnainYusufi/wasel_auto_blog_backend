import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChatCompletionResponse,
  ChatMessage,
  ChatOptions,
  ImageGenerationResponse,
} from './minimax.types';
import { extractJson } from '../common/json.util';
import { postJson } from '../common/http.util';

const PLACEHOLDER_KEY = 'your_minimax_api_key_here';
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
/** MiniMax signals rate limiting / transient server faults through base_resp too. */
const RETRYABLE_BASE_RESP = new Set([1002, 1027, 1039, 1042, 2013, 2049]);

@Injectable()
export class MinimaxService {
  private readonly logger = new Logger(MinimaxService.name);

  constructor(private readonly config: ConfigService) {}

  get baseUrl(): string {
    return (
      this.config.get<string>('MINIMAX_BASE_URL') ?? 'https://api.minimax.io/v1'
    ).replace(/\/+$/, '');
  }

  get apiKey(): string {
    const key = this.config.get<string>('MINIMAX_API_KEY')?.trim();
    if (!key || key === PLACEHOLDER_KEY) {
      throw new ServiceUnavailableException(
        'MINIMAX_API_KEY is not configured. Add your key to the backend .env file and restart.',
      );
    }
    return key;
  }

  /** True when a real key is present — used by the health endpoint. */
  get isConfigured(): boolean {
    const key = this.config.get<string>('MINIMAX_API_KEY')?.trim();
    return Boolean(key) && key !== PLACEHOLDER_KEY;
  }

  get defaultTextModel(): string {
    return this.config.get<string>('MINIMAX_TEXT_MODEL') ?? 'MiniMax-M2.5';
  }

  get defaultImageModel(): string {
    return this.config.get<string>('MINIMAX_IMAGE_MODEL') ?? 'image-01';
  }

  /** Plain text completion. */
  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const model = options.model ?? this.defaultTextModel;

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.8,
      top_p: options.topP ?? 0.95,
      max_completion_tokens: options.maxTokens ?? 8192,
    };

    // `thinking` is only understood by the M3 family; sending it elsewhere is rejected.
    if (options.thinking && model.startsWith('MiniMax-M3')) {
      body.thinking = { type: options.thinking };
    }

    const response = await this.request<ChatCompletionResponse>(
      '/chat/completions',
      body,
    );

    const content = stripReasoning(response.choices?.[0]?.message?.content ?? '');
    if (!content) {
      throw new ServiceUnavailableException(
        'MiniMax returned an empty completion. Try again or pick a different model.',
      );
    }
    return content;
  }

  /**
   * Completion constrained to a JSON object. MiniMax models happily wrap JSON in
   * prose or code fences, so the response is salvaged with a tolerant extractor and
   * one corrective retry before giving up.
   */
  async chatJson<T>(messages: ChatMessage[], options: ChatOptions = {}): Promise<T> {
    const jsonMessages: ChatMessage[] = [
      ...messages,
      {
        role: 'system',
        content:
          'Respond with a single valid JSON object and nothing else. No markdown fences, no commentary, no trailing text.',
      },
    ];

    const raw = await this.chat(jsonMessages, { temperature: 0.6, ...options });
    const parsed = extractJson<T>(raw);
    if (parsed) return parsed;

    this.logger.warn('First JSON parse failed, asking the model to repair its output');

    const repaired = await this.chat(
      [
        ...jsonMessages,
        { role: 'assistant', content: raw.slice(0, 6000) },
        {
          role: 'user',
          content:
            'That was not parseable JSON. Return the exact same information as one strictly valid JSON object. Start with { and end with }.',
        },
      ],
      { ...options, temperature: 0.2 },
    );

    const repairedJson = extractJson<T>(repaired);
    if (repairedJson) return repairedJson;

    throw new ServiceUnavailableException(
      'MiniMax did not return parseable JSON after a retry.',
    );
  }

  /** Text-to-image. Returns temporary URLs that expire after 24h — persist them. */
  async generateImages(params: {
    prompt: string;
    aspectRatio?: string;
    n?: number;
    model?: string;
    promptOptimizer?: boolean;
  }): Promise<string[]> {
    const response = await this.request<ImageGenerationResponse>('/image_generation', {
      model: params.model ?? this.defaultImageModel,
      prompt: params.prompt.slice(0, 1500),
      aspect_ratio: params.aspectRatio ?? '16:9',
      n: Math.min(Math.max(params.n ?? 1, 1), 9),
      prompt_optimizer: params.promptOptimizer ?? true,
      response_format: 'url',
    });

    const urls = response.data?.image_urls ?? [];
    if (!urls.length) {
      throw new ServiceUnavailableException(
        'MiniMax image generation returned no images.',
      );
    }
    return urls;
  }

  /**
   * MiniMax answers with HTTP 200 even for logical failures, so both the transport
   * status and `base_resp.status_code` have to be checked on every call.
   */
  private async request<T extends { base_resp?: { status_code: number; status_msg: string } }>(
    path: string,
    body: unknown,
    attempt = 1,
  ): Promise<T> {
    const maxAttempts = 4;
    const url = `${this.baseUrl}${path}`;

    let res: { status: number; text: string };
    try {
      res = await postJson(url, body, {
        Authorization: `Bearer ${this.apiKey}`,
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        await this.backoff(attempt);
        return this.request<T>(path, body, attempt + 1);
      }
      throw new ServiceUnavailableException(
        `Could not reach MiniMax (${(err as Error).message}).`,
      );
    }

    const text = res.text;
    const ok = res.status >= 200 && res.status < 300;

    if (!ok) {
      if (RETRYABLE_HTTP.has(res.status) && attempt < maxAttempts) {
        await this.backoff(attempt);
        return this.request<T>(path, body, attempt + 1);
      }
      if (res.status === 401 || res.status === 403) {
        throw new ServiceUnavailableException(
          'MiniMax rejected the API key. Set a valid MINIMAX_API_KEY in the backend .env and restart the server.',
        );
      }
      if (res.status === 429) {
        throw new ServiceUnavailableException(
          'MiniMax rate limit reached. Wait a moment and try again.',
        );
      }
      throw new ServiceUnavailableException(
        `MiniMax ${path} failed with HTTP ${res.status}: ${text.slice(0, 400)}`,
      );
    }

    let json: T;
    try {
      json = JSON.parse(text) as T;
    } catch {
      throw new ServiceUnavailableException(
        `MiniMax ${path} returned a non-JSON body: ${text.slice(0, 300)}`,
      );
    }

    const status = json.base_resp?.status_code;
    if (status !== undefined && status !== 0) {
      if (RETRYABLE_BASE_RESP.has(status) && attempt < maxAttempts) {
        this.logger.warn(
          `MiniMax ${path} transient error ${status}, retry ${attempt}/${maxAttempts}`,
        );
        await this.backoff(attempt);
        return this.request<T>(path, body, attempt + 1);
      }
      throw new ServiceUnavailableException(
        `MiniMax ${path} error ${status}: ${json.base_resp?.status_msg ?? 'unknown error'}`,
      );
    }

    return json;
  }

  private backoff(attempt: number): Promise<void> {
    const delay = Math.min(1500 * 2 ** (attempt - 1), 12000);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * The M-series can emit its chain of thought inline as <think>…</think> before
 * the answer. Strip it so it never reaches the article or the JSON parser.
 */
function stripReasoning(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim();
}
