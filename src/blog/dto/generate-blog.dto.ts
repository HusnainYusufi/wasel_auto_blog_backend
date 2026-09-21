import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ASPECT_RATIOS } from '../../minimax/minimax.types';
import { ALL_TEXT_MODELS } from '../text-models';
import { TEXT_PROVIDER_IDS } from '../../providers/text-provider.interface';
import { LENGTH_PRESETS } from '../blog.prompts';

export const TONES = [
  'professional',
  'conversational',
  'authoritative',
  'friendly',
  'witty',
  'inspirational',
  'technical',
  'storytelling',
] as const;

export const POINTS_OF_VIEW = ['first-person', 'second-person', 'third-person'] as const;

export const IMAGE_STYLES = [
  'modern editorial photography',
  'minimal 3D render',
  'soft gradient illustration',
  'flat vector illustration',
  'cinematic photography',
  'isometric illustration',
  'watercolor illustration',
  'abstract tech visualization',
] as const;

export class GenerateBlogDto {
  @IsString()
  @Length(3, 300)
  topic: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    const raw = Array.isArray(value)
      ? value.map((v) => String(v))
      : String(value ?? '').split(/[\n,;]/);

    // Preserve non-Latin keywords verbatim; only normalise whitespace.
    const seen = new Set<string>();
    const out: string[] = [];

    for (const entry of raw) {
      const keyword = entry.replace(/\s+/g, ' ').trim();
      if (!keyword) continue;
      const key = keyword.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(keyword);
      if (out.length >= 50) break;
    }

    return out;
  })
  keywords: string[] = [];

  /** Saved keyword sets to merge into `keywords`. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywordSetIds: string[] = [];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  language = 'English';

  @IsOptional()
  @IsIn(TONES)
  tone: (typeof TONES)[number] = 'professional';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  audience = 'general readers';

  @IsOptional()
  @IsIn(Object.keys(LENGTH_PRESETS))
  lengthPreset = 'standard';

  @IsOptional()
  @IsIn(POINTS_OF_VIEW)
  pointOfView: (typeof POINTS_OF_VIEW)[number] = 'second-person';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  brandName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  callToAction?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  imageCount = 3;

  @IsOptional()
  @IsIn(ASPECT_RATIOS)
  aspectRatio = '16:9';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  imageStyle = 'modern editorial photography';

  @IsOptional()
  @IsBoolean()
  includeFaq = true;

  @IsOptional()
  @IsBoolean()
  includeToc = true;

  /** Which engine writes the article. Omit to use the configured default. */
  @IsOptional()
  @IsIn(TEXT_PROVIDER_IDS)
  textProvider?: string;

  @IsOptional()
  @IsIn(ALL_TEXT_MODELS)
  textModel?: string;

  /** Steer the article with previously published work. */
  @IsOptional()
  @IsBoolean()
  useKnowledgeBase = false;

  /** Restrict the briefing to specific sources; empty means all ready sources. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  knowledgeSourceIds: string[] = [];
}
