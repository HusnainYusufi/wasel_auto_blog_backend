import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  Sse,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { BlogService } from './blog.service';
import { GenerateBlogDto, IMAGE_STYLES, POINTS_OF_VIEW, TONES } from './dto/generate-blog.dto';
import { LENGTH_PRESETS } from './blog.prompts';
import { ASPECT_RATIOS } from '../minimax/minimax.types';
import { TextProviderRegistry } from '../providers/text-provider.registry';
import { ImageProviderRegistry } from '../providers/image-provider.registry';
import { ProgressEvent } from './blog.events';
import { PIPELINE_STEPS } from './blog.events';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ReviewDto } from './dto/review.dto';

@Controller('blogs')
export class BlogController {
  constructor(
    private readonly blogService: BlogService,
    private readonly textProviders: TextProviderRegistry,
    private readonly imageProviders: ImageProviderRegistry,
  ) {}

  /** Everything the generator form needs to render itself. */
  @Get('options')
  options() {
    // Must honour TEXT_PROVIDER, not just list order — defaultProvider() does
    // that and falls back when the preferred engine has no key.
    let defaultProvider: { id: string; defaultModel: string } | null = null;
    try {
      defaultProvider = this.textProviders.defaultProvider();
    } catch {
      // Nothing configured at all is a setup problem, not a request error.
      defaultProvider = null;
    }

    let defaultImageProvider: { id: string; defaultImageModel: string } | null = null;
    try {
      defaultImageProvider = this.imageProviders.defaultProvider();
    } catch {
      defaultImageProvider = null;
    }

    return {
      tones: TONES,
      pointsOfView: POINTS_OF_VIEW,
      imageStyles: IMAGE_STYLES,
      aspectRatios: ASPECT_RATIOS,
      textProviders: this.textProviders.list().map((p) => ({
        id: p.id,
        label: p.label,
        configured: p.isConfigured,
        models: p.models,
        defaultModel: p.isConfigured ? p.defaultModel : null,
      })),
      lengthPresets: Object.entries(LENGTH_PRESETS).map(([key, value]) => ({
        key,
        ...value,
      })),
      steps: PIPELINE_STEPS,
      imageProviders: this.imageProviders.list().map((p) => ({
        id: p.id,
        label: p.label,
        configured: p.isConfigured,
        defaultModel: p.isConfigured ? p.defaultImageModel : null,
      })),
      defaults: {
        textProvider: defaultProvider?.id ?? null,
        textModel: defaultProvider?.defaultModel ?? null,
        imageProvider: defaultImageProvider?.id ?? null,
        imageModel: defaultImageProvider?.defaultImageModel ?? null,
      },
    };
  }

  @Post()
  create(@Body() dto: GenerateBlogDto, @CurrentUser('id') userId: string) {
    return this.blogService.create(dto, userId);
  }

  @Get()
  findAll(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('reviewStatus') reviewStatus?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.blogService.findAll({
      search,
      status,
      reviewStatus,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Public()
  @Sse(':id/stream')
  stream(@Param('id') id: string): Observable<{ data: ProgressEvent }> {
    return this.blogService.stream(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.blogService.findOne(id);
  }

  @Get(':id/history')
  history(@Param('id') id: string) {
    return this.blogService.history(id);
  }

  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @Body() dto: ReviewDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.blogService.approve(id, userId, dto?.note);
  }

  @Post(':id/reject')
  reject(
    @Param('id') id: string,
    @Body() dto: ReviewDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.blogService.reject(id, userId, dto?.note);
  }

  @Post(':id/reopen')
  reopen(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.blogService.reopen(id, userId);
  }

  @Post(':id/images/:imageId/regenerate')
  regenerateImage(@Param('id') id: string, @Param('imageId') imageId: string) {
    return this.blogService.regenerateImage(id, imageId);
  }

  @Public()
  @Get(':id/export')
  async export(
    @Param('id') id: string,
    @Query('format') format = 'md',
    @Res() res: Response,
  ) {
    const file = await this.blogService.exportBlog(id, format);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.blogService.remove(id);
  }
}
