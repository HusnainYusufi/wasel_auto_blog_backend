/**
 * The image capability the generation pipeline depends on.
 *
 * Providers differ in how they hand back the result — MiniMax returns
 * short-lived URLs, Gemini returns base64 inline data — so implementations
 * normalise to this shape and the pipeline stays unaware of the difference.
 */
export interface GeneratedImage {
  /** A URL to download, when the provider hosts the file itself. */
  url?: string;
  /** Raw bytes, when the provider returns the image inline. */
  buffer?: Buffer;
  /** Content type for the bytes, e.g. 'image/jpeg'. */
  contentType?: string;
}

export interface ImageProvider {
  readonly id: ImageProviderId;
  readonly label: string;
  readonly isConfigured: boolean;
  /**
   * Named distinctly from TextProvider.defaultModel: a provider can implement
   * both contracts, and a shared property name silently resolved to the text
   * model when the image registry asked for a default.
   */
  readonly defaultImageModel: string;

  generateImage(params: {
    prompt: string;
    aspectRatio?: string;
    model?: string;
  }): Promise<GeneratedImage>;
}

export const IMAGE_PROVIDER_IDS = ['minimax', 'gemini'] as const;
export type ImageProviderId = (typeof IMAGE_PROVIDER_IDS)[number];

export function isImageProviderId(value: unknown): value is ImageProviderId {
  return IMAGE_PROVIDER_IDS.includes(value as ImageProviderId);
}

/** Aspect ratios Gemini's imageConfig accepts. */
export const GEMINI_IMAGE_MODELS = [
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-3-pro-image',
  'gemini-2.5-flash-image',
] as const;
