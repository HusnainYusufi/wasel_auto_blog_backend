import { TEXT_MODELS } from '../minimax/minimax.types';
import { GEMINI_TEXT_MODELS } from '../gemini/gemini.types';

/** Union of every selectable text model, for request validation. */
export const ALL_TEXT_MODELS = [...TEXT_MODELS, ...GEMINI_TEXT_MODELS] as const;
