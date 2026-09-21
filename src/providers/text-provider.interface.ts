import { ChatMessage, ChatOptions } from '../minimax/minimax.types';

/**
 * The text capabilities the generation pipeline depends on. MiniMax and Gemini
 * both satisfy this, so a blog can be written by either without the pipeline
 * knowing which one it is talking to.
 */
export interface TextProvider {
  /** Stable identifier used in the DB and the API surface, e.g. 'minimax'. */
  readonly id: TextProviderId;

  /** Human label for the UI. */
  readonly label: string;

  /** True when an API key is configured for this provider. */
  readonly isConfigured: boolean;

  /** Model ids this provider accepts. */
  readonly models: readonly string[];

  /** Model used when the request does not name one. */
  readonly defaultModel: string;

  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;

  chatJson<T>(messages: ChatMessage[], options?: ChatOptions): Promise<T>;
}

export const TEXT_PROVIDER_IDS = ['minimax', 'gemini'] as const;
export type TextProviderId = (typeof TEXT_PROVIDER_IDS)[number];

/**
 * Model ids are globally unique across providers, so a stored `textModel` is
 * enough to route a regeneration back to the provider that produced it.
 */
export function isTextProviderId(value: unknown): value is TextProviderId {
  return TEXT_PROVIDER_IDS.includes(value as TextProviderId);
}
