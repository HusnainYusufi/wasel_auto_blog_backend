export interface GeminiPart {
  text?: string;
  /** Reasoning trace marker returned by the 2.5+ models; not prose. */
  thoughtSignature?: string;
  thought?: boolean;
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
    safetyRatings?: Array<{ category: string; probability: string }>;
  }>;
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{ category: string; probability: string }>;
  };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Verified against GET /v1beta/models (generateContent-capable, non-TTS,
 * non-image, non-Gemma). `*-latest` aliases track Google's current release.
 */
export const GEMINI_TEXT_MODELS = [
  'gemini-flash-latest',
  'gemini-pro-latest',
  'gemini-flash-lite-latest',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
] as const;

export type GeminiTextModel = (typeof GEMINI_TEXT_MODELS)[number];
