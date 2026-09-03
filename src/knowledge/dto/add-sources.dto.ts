import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class AddSourcesDto {
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) =>
    (Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/))
      .map((url: string) => url.trim())
      .filter(Boolean)
      .slice(0, 25),
  )
  urls: string[];

  /** Treat each URL as a listing page and pull in the posts it links to. */
  @IsOptional()
  @IsBoolean()
  discoverLinks = false;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(40)
  maxPages = 10;
}
