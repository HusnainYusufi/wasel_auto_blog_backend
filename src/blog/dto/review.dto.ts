import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewDto {
  /** Why it was approved or rejected — shown in the article's history. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
