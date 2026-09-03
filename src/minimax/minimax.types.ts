export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** MiniMax-M3 supports adaptive thinking; disable it for faster deterministic drafting. */
  thinking?: 'adaptive' | 'disabled';
}

export interface MinimaxBaseResp {
  status_code: number;
  status_msg: string;
}

export interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{
    finish_reason?: string;
    index?: number;
    message?: { role?: string; content?: string; reasoning_content?: string };
  }>;
  usage?: { total_tokens?: number };
  base_resp?: MinimaxBaseResp;
  error?: { message?: string; type?: string; code?: string | number };
}

export interface ImageGenerationResponse {
  id?: string;
  data?: { image_urls?: string[] | null; image_base64?: string[] | null };
  metadata?: { success_count?: number | string; failed_count?: number | string };
  base_resp?: MinimaxBaseResp;
}

export const ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '4:3',
  '3:2',
  '2:3',
  '3:4',
  '9:16',
  '21:9',
] as const;

export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const TEXT_MODELS = [
  'MiniMax-M3',
  'MiniMax-M2.7',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed',
  'MiniMax-M2.1',
  'MiniMax-M2.1-highspeed',
  'MiniMax-M2',
] as const;

export type TextModel = (typeof TEXT_MODELS)[number];
