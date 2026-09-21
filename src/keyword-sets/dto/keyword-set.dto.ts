import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Accepts either an array or a newline/comma-separated blob, so a list can be
 * pasted straight in. Arabic is preserved verbatim — only whitespace is
 * normalised and duplicates removed (case-insensitively for Latin text).
 */
const normalizeKeywords = ({ value }: { value: unknown }): string[] => {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v))
    : String(value ?? '').split(/[\n,;]/);

  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of raw) {
    const keyword = entry.replace(/\s+/g, ' ').trim();
    if (!keyword) continue;

    const key = keyword.toLocaleLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(keyword);
    if (out.length >= 100) break;
  }

  return out;
};

export class CreateKeywordSetDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Transform(({ value }) => String(value ?? '').trim())
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1, { message: 'Add at least one keyword' })
  @ArrayMaxSize(100)
  @Transform(normalizeKeywords)
  keywords: string[];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  language?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class UpdateKeywordSetDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Transform(({ value }) => (value === undefined ? undefined : String(value).trim()))
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(100)
  @Transform(normalizeKeywords)
  keywords?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  language?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}
