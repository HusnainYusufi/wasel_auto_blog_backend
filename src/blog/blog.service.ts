import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Observable, Subject, concat, from } from 'rxjs';
import { concatMap, map } from 'rxjs/operators';
import { PrismaService } from '../prisma/prisma.service';
import { MinimaxService } from '../minimax/minimax.service';
import { StorageService } from '../storage/storage.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { GenerateBlogDto } from './dto/generate-blog.dto';
import {
  Blueprint,
  BlueprintRequest,
  LENGTH_PRESETS,
  SeoPack,
  InterlinkSuggestion,
  articlePrompt,
  blueprintPrompt,
  interlinkPrompt,
  imagePrompt,
  seoPackPrompt,
} from './blog.prompts';
import { PIPELINE_STEPS, ProgressEvent } from './blog.events';
import { countWords, keywordDensity, readingMinutes, slugify } from '../common/text.util';
import { markdownToHtml } from '../common/markdown.util';

interface PlannedImage {
  token: string;
  role: 'hero' | 'section';
  sectionIndex: number | null;
  prompt: string;
  alt: string;
  caption: string;
}

@Injectable()
export class BlogService {
  private readonly logger = new Logger(BlogService.name);
  /** Live progress channels, keyed by blog id, for the SSE endpoint. */
  private readonly channels = new Map<string, Subject<ProgressEvent>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly minimax: MinimaxService,
    private readonly storage: StorageService,
    private readonly knowledge: KnowledgeService,
  ) {}

  // ------------------------------------------------------------------ review

  private async audit(
    blogId: string,
    action: string,
    userId?: string | null,
    note = '',
  ) {
    await this.prisma.blogAuditLog.create({
      data: { blogId, action, note, userId: userId ?? null },
    });
  }

  /** Keep the article: it moves out of the review queue as approved. */
  async approve(id: string, userId: string, note?: string) {
    return this.setReview(id, 'approved', userId, note);
  }

  /** Reject the article. It stays in history with the reason recorded. */
  async reject(id: string, userId: string, note?: string) {
    return this.setReview(id, 'rejected', userId, note);
  }

  /** Send a decided article back to the pending queue. */
  async reopen(id: string, userId: string) {
    return this.setReview(id, 'pending', userId, '');
  }

  private async setReview(
    id: string,
    reviewStatus: 'pending' | 'approved' | 'rejected',
    userId: string,
    note?: string,
  ) {
    const blog = await this.prisma.blog.findUnique({ where: { id } });
    if (!blog) throw new NotFoundException(`Blog ${id} not found`);

    if (blog.status !== 'completed') {
      throw new BadRequestException(
        'Only a finished article can be reviewed.',
      );
    }
    if (blog.reviewStatus === reviewStatus) {
      throw new BadRequestException(`This article is already ${reviewStatus}.`);
    }

    const updated = await this.prisma.blog.update({
      where: { id },
      data: {
        reviewStatus,
        reviewNote: note?.trim() || null,
        reviewedById: userId,
        reviewedAt: reviewStatus === 'pending' ? null : new Date(),
      },
    });

    await this.audit(
      id,
      reviewStatus === 'pending' ? 'reopened' : reviewStatus,
      userId,
      note?.trim() ?? '',
    );

    return {
      id: updated.id,
      reviewStatus: updated.reviewStatus,
      reviewNote: updated.reviewNote,
      reviewedAt: updated.reviewedAt,
    };
  }

  async history(id: string) {
    const blog = await this.prisma.blog.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!blog) throw new NotFoundException(`Blog ${id} not found`);

    const logs = await this.prisma.blogAuditLog.findMany({
      where: { blogId: id },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    return logs.map((log) => ({
      id: log.id,
      action: log.action,
      note: log.note,
      createdAt: log.createdAt,
      user: log.user ? { name: log.user.name, email: log.user.email } : null,
    }));
  }

  // ---------------------------------------------------------------- creation

  async create(dto: GenerateBlogDto, userId?: string) {
    const blog = await this.prisma.blog.create({
      data: {
        topic: dto.topic,
        keywords: JSON.stringify(dto.keywords ?? []),
        language: dto.language,
        tone: dto.tone,
        audience: dto.audience,
        lengthPreset: dto.lengthPreset,
        pointOfView: dto.pointOfView,
        brandName: dto.brandName ?? null,
        callToAction: dto.callToAction ?? null,
        imageCount: dto.imageCount,
        aspectRatio: dto.aspectRatio,
        imageStyle: dto.imageStyle,
        includeFaq: dto.includeFaq,
        includeToc: dto.includeToc,
        textModel: dto.textModel ?? this.minimax.defaultTextModel,
        imageModel: this.minimax.defaultImageModel,
        status: 'queued',
        title: dto.topic,
        knowledgeSourceIds: JSON.stringify(
          dto.useKnowledgeBase ? (dto.knowledgeSourceIds ?? []) : [],
        ),
        useKnowledgeBase: dto.useKnowledgeBase,
        createdById: userId ?? null,
      },
    });

    this.channels.set(blog.id, new Subject<ProgressEvent>());
    await this.audit(blog.id, 'created', userId, dto.topic);

    // Fire-and-forget: the client follows progress over SSE.
    void this.run(blog.id).catch((err) =>
      this.logger.error(`Generation crashed for ${blog.id}: ${err.message}`, err.stack),
    );

    return { id: blog.id, status: blog.status };
  }

  // ---------------------------------------------------------------- pipeline

  private async run(blogId: string): Promise<void> {
    const blog = await this.prisma.blog.findUnique({ where: { id: blogId } });
    if (!blog) return;

    const req: BlueprintRequest = {
      topic: blog.topic,
      keywords: safeParse<string[]>(blog.keywords, []),
      language: blog.language,
      tone: blog.tone,
      audience: blog.audience,
      lengthPreset: blog.lengthPreset,
      pointOfView: blog.pointOfView,
      brandName: blog.brandName ?? undefined,
      callToAction: blog.callToAction ?? undefined,
      includeFaq: blog.includeFaq,
      imageCount: blog.imageCount,
      imageStyle: blog.imageStyle,
    };

    if (blog.useKnowledgeBase) {
      const selected = safeParse<string[]>(blog.knowledgeSourceIds, []);
      req.knowledge = await this.knowledge.buildContext(selected);
      if (req.knowledge) {
        await this.prisma.blog.update({
          where: { id: blogId },
          data: { knowledgeSourceIds: JSON.stringify(req.knowledge.sourceIds) },
        });
      }
    }

    const model = blog.textModel;

    try {
      await this.prisma.blog.update({
        where: { id: blogId },
        data: { status: 'running', startedAt: new Date(), progress: 2 },
      });

      // 1. Blueprint -------------------------------------------------------
      await this.emit(blogId, 'blueprint', 'running', 'Researching angles and shaping the outline…', 6);
      const blueprint = normalizeBlueprint(
        await this.minimax.chatJson<Blueprint>(blueprintPrompt(req), {
          model,
          temperature: 0.7,
          maxTokens: 8192,
        }),
        req,
      );

      await this.prisma.blog.update({
        where: { id: blogId },
        data: {
          title: blueprint.title,
          slug: blueprint.slug,
          metaTitle: blueprint.metaTitle,
          metaDescription: blueprint.metaDescription,
          excerpt: blueprint.excerpt,
          outline: JSON.stringify(blueprint),
        },
      });
      await this.emit(
        blogId,
        'blueprint',
        'done',
        `Outline ready — ${blueprint.sections.length} sections around "${blueprint.primaryKeyword}"`,
        24,
      );

      // 2. Article ---------------------------------------------------------
      const planned = this.planImages(blueprint, req);
      await this.emit(blogId, 'writing', 'running', 'Drafting the full article…', 30);

      const preset = LENGTH_PRESETS[req.lengthPreset] ?? LENGTH_PRESETS.standard;
      let markdown = cleanMarkdown(
        await this.minimax.chat(articlePrompt(req, blueprint, planned), {
          model,
          temperature: 0.85,
          maxTokens: Math.min(32000, Math.round(preset.words * 6) + 3000),
        }),
      );

      // Internal links, chosen by the model but inserted deterministically so
      // they always land on text that actually exists in the draft.
      let linkCount = 0;
      if (req.knowledge?.existingArticles.length) {
        await this.emit(blogId, 'writing', 'running', 'Linking to your existing posts…', 50);
        try {
          const { links } = await this.minimax.chatJson<{ links: InterlinkSuggestion[] }>(
            interlinkPrompt(markdown, req.knowledge.existingArticles),
            { model, temperature: 0.3, maxTokens: 2000 },
          );
          const result = applyInternalLinks(markdown, links ?? []);
          markdown = result.markdown;
          linkCount = result.applied;
        } catch (err) {
          this.logger.warn(
            `Internal linking skipped for ${blogId}: ${(err as Error).message}`,
          );
        }
      }

      await this.emit(
        blogId,
        'writing',
        'done',
        `Draft complete — ${countWords(markdown).toLocaleString()} words${linkCount ? `, ${linkCount} internal links` : ''}`,
        56,
      );

      // 3. Images ----------------------------------------------------------
      const saved: PlannedImage[] = [];
      if (planned.length) {
        await this.emit(
          blogId,
          'images',
          'running',
          `Generating ${planned.length} original image${planned.length > 1 ? 's' : ''}…`,
          58,
        );

        const span = 84 - 58;
        let completed = 0;

        // Two at a time keeps well inside MiniMax's image rate limits.
        for (const batch of chunk(planned, 2)) {
          // Each task swallows its own failure so a dead image never loses its plan.
          const results = await Promise.all(
            batch.map(async (plan) => {
              try {
                const [remoteUrl] = await this.minimax.generateImages({
                  prompt: imagePrompt(plan.prompt, req.imageStyle),
                  aspectRatio: blog.aspectRatio,
                  n: 1,
                });
                const url = await this.storage.saveRemoteImage(remoteUrl, blogId);
                return { plan, url, error: null as string | null };
              } catch (err) {
                return { plan, url: null, error: (err as Error).message };
              }
            }),
          );

          for (const { plan, url, error } of results) {
            completed++;
            if (url) {
              await this.prisma.blogImage.create({
                data: {
                  blogId,
                  role: plan.role,
                  sectionIndex: plan.sectionIndex,
                  placeholder: plan.token,
                  prompt: plan.prompt,
                  alt: plan.alt,
                  caption: plan.caption,
                  url,
                  aspectRatio: blog.aspectRatio,
                },
              });
              if (plan.role === 'hero') {
                await this.prisma.blog.update({
                  where: { id: blogId },
                  data: { heroImageUrl: url },
                });
              }
              saved.push(plan);
              markdown = replaceToken(markdown, plan.token, url, plan.alt, plan.caption);
            } else {
              this.logger.warn(`Image failed for ${blogId}: ${error}`);
              markdown = replaceToken(markdown, plan.token, null, '', '');
            }

            await this.emit(
              blogId,
              'images',
              'running',
              `Rendered ${completed} of ${planned.length} images`,
              Math.round(58 + (span * completed) / planned.length),
            );
          }
        }
      }

      // Strip any placeholder the model echoed but we never filled.
      markdown = markdown.replace(/^\s*\[\[IMAGE_\d+\]\]\s*$/gm, '').replace(/\n{3,}/g, '\n\n');
      await this.emit(blogId, 'images', 'done', `${saved.length} images placed in the article`, 84);

      // 4. SEO pack ---------------------------------------------------------
      await this.emit(blogId, 'seo', 'running', 'Scoring on-page SEO and writing social copy…', 86);
      let seoPack: SeoPack | null = null;
      try {
        seoPack = await this.minimax.chatJson<SeoPack>(
          seoPackPrompt(req, blueprint, markdown),
          { model, temperature: 0.5, maxTokens: 4096 },
        );
      } catch (err) {
        this.logger.warn(`SEO pack failed for ${blogId}: ${(err as Error).message}`);
      }
      await this.emit(blogId, 'seo', 'done', 'SEO audit complete', 94);

      // 5. Assemble ---------------------------------------------------------
      await this.emit(blogId, 'assemble', 'running', 'Building exports and structured data…', 96);

      if (blog.includeToc) {
        markdown = insertTableOfContents(markdown);
      }

      const words = countWords(markdown);
      const allKeywords = dedupe([
        blueprint.primaryKeyword,
        ...(blueprint.secondaryKeywords ?? []),
        ...req.keywords,
      ]);

      const seo = {
        ...(seoPack ?? {}),
        primaryKeyword: blueprint.primaryKeyword,
        secondaryKeywords: blueprint.secondaryKeywords ?? [],
        searchIntent: blueprint.searchIntent,
        keywordDensity: keywordDensity(markdown, allKeywords),
        faq: blueprint.faq ?? [],
        jsonLd: buildJsonLd(blueprint, words, blog.brandName),
      };

      await this.prisma.blog.update({
        where: { id: blogId },
        data: {
          contentMarkdown: markdown,
          contentHtml: markdownToHtml(markdown),
          seo: JSON.stringify(seo),
          wordCount: words,
          readingMinutes: readingMinutes(words),
          status: 'completed',
          progress: 100,
          currentStep: 'done',
          completedAt: new Date(),
        },
      });

      await this.audit(blogId, 'completed', blog.createdById, `${words} words`);
      await this.emit(blogId, 'assemble', 'done', 'Your article is ready', 100);
      await this.emit(blogId, 'done', 'done', 'completed', 100);
    } catch (err) {
      const message = (err as Error).message ?? 'Generation failed';
      this.logger.error(`Generation failed for ${blogId}: ${message}`);
      await this.prisma.blog.update({
        where: { id: blogId },
        data: { status: 'failed', error: message, currentStep: 'failed' },
      });
      await this.audit(blogId, 'failed', null, message.slice(0, 300));
      await this.emit(blogId, 'failed', 'failed', message, 100);
    } finally {
      const channel = this.channels.get(blogId);
      channel?.complete();
      this.channels.delete(blogId);
    }
  }

  private planImages(blueprint: Blueprint, req: BlueprintRequest): PlannedImage[] {
    if (req.imageCount <= 0) return [];

    const prompts = (blueprint.imagePrompts ?? []).slice(0, req.imageCount);
    const planned: PlannedImage[] = [];
    const usedSections = new Set<number>();

    prompts.forEach((entry, index) => {
      const isHero = entry.role === 'hero' || (index === 0 && !planned.some((p) => p.role === 'hero'));
      let sectionIndex: number | null = null;

      if (!isHero) {
        const total = blueprint.sections.length || 1;
        let candidate = Number.isInteger(entry.sectionIndex as number)
          ? Math.min(Math.max(entry.sectionIndex as number, 0), total - 1)
          : Math.round((index * total) / Math.max(prompts.length, 1));
        // Never stack two images in the same section.
        while (usedSections.has(candidate) && usedSections.size < total) {
          candidate = (candidate + 1) % total;
        }
        usedSections.add(candidate);
        sectionIndex = candidate;
      }

      planned.push({
        token: `[[IMAGE_${index + 1}]]`,
        role: isHero ? 'hero' : 'section',
        sectionIndex,
        prompt: entry.prompt ?? `${blueprint.title} — editorial illustration`,
        alt: (entry.alt ?? blueprint.title).slice(0, 125),
        caption: entry.caption ?? '',
      });
    });

    return planned;
  }

  private async emit(
    blogId: string,
    step: ProgressEvent['step'],
    status: ProgressEvent['status'],
    message: string,
    progress: number,
  ): Promise<void> {
    const event: ProgressEvent = {
      blogId,
      step,
      status,
      message,
      progress,
      createdAt: new Date().toISOString(),
    };

    await this.prisma.generationEvent.create({
      data: { blogId, step, status, message, progress },
    });
    await this.prisma.blog.update({
      where: { id: blogId },
      data: { progress, currentStep: step },
    });

    this.channels.get(blogId)?.next(event);
  }

  // ------------------------------------------------------------------ reads

  /** Replays everything already recorded, then follows the live channel. */
  stream(blogId: string): Observable<{ data: ProgressEvent }> {
    const history$ = from(this.loadHistory(blogId)).pipe(
      concatMap((events) => from(events)),
    );

    const live = this.channels.get(blogId);
    const source = live ? concat(history$, live.asObservable()) : history$;

    return source.pipe(map((event) => ({ data: event })));
  }

  private async loadHistory(blogId: string): Promise<ProgressEvent[]> {
    const events = await this.prisma.generationEvent.findMany({
      where: { blogId },
      orderBy: { createdAt: 'asc' },
    });

    return events.map((e) => ({
      blogId,
      step: e.step as ProgressEvent['step'],
      status: e.status as ProgressEvent['status'],
      message: e.message,
      progress: e.progress,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  async findAll(params: {
    search?: string;
    status?: string;
    reviewStatus?: string;
    take?: number;
    skip?: number;
  }) {
    const where: Record<string, unknown> = {};
    if (params.status) where.status = params.status;
    if (params.reviewStatus) where.reviewStatus = params.reviewStatus;
    if (params.search) {
      where.OR = [
        { title: { contains: params.search } },
        { topic: { contains: params.search } },
      ];
    }

    const [items, total, counts] = await Promise.all([
      this.prisma.blog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(params.take ?? 30, 100),
        skip: params.skip ?? 0,
        include: { images: { where: { role: 'hero' }, take: 1 } },
      }),
      this.prisma.blog.count({ where }),
      this.prisma.blog.groupBy({
        by: ['reviewStatus'],
        where: { status: 'completed' },
        _count: true,
      }),
    ]);

    const reviewCounts = { pending: 0, approved: 0, rejected: 0 };
    for (const row of counts) {
      if (row.reviewStatus in reviewCounts) {
        reviewCounts[row.reviewStatus as keyof typeof reviewCounts] = row._count;
      }
    }

    return { total, reviewCounts, items: items.map((b) => this.toSummary(b)) };
  }

  async findOne(id: string) {
    const blog = await this.prisma.blog.findUnique({
      where: { id },
      include: {
        images: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!blog) throw new NotFoundException(`Blog ${id} not found`);

    return {
      ...this.toSummary(blog),
      contentMarkdown: blog.contentMarkdown,
      contentHtml: blog.contentHtml,
      outline: safeParse(blog.outline, null),
      seo: safeParse(blog.seo, null),
      error: blog.error,
      config: {
        language: blog.language,
        tone: blog.tone,
        audience: blog.audience,
        lengthPreset: blog.lengthPreset,
        pointOfView: blog.pointOfView,
        brandName: blog.brandName,
        callToAction: blog.callToAction,
        imageCount: blog.imageCount,
        aspectRatio: blog.aspectRatio,
        imageStyle: blog.imageStyle,
        includeFaq: blog.includeFaq,
        includeToc: blog.includeToc,
        textModel: blog.textModel,
        imageModel: blog.imageModel,
        useKnowledgeBase: blog.useKnowledgeBase,
        knowledgeSourceIds: safeParse<string[]>(blog.knowledgeSourceIds, []),
      },
      images: blog.images,
      events: blog.events.map((e) => ({
        step: e.step,
        status: e.status,
        message: e.message,
        progress: e.progress,
        createdAt: e.createdAt,
      })),
    };
  }

  async remove(id: string) {
    const blog = await this.prisma.blog.findUnique({ where: { id } });
    if (!blog) throw new NotFoundException(`Blog ${id} not found`);
    await this.prisma.blog.delete({ where: { id } });
    await this.storage.removeBlogAssets(id);
    return { id, deleted: true };
  }

  async regenerateImage(blogId: string, imageId: string) {
    const image = await this.prisma.blogImage.findFirst({
      where: { id: imageId, blogId },
      include: { blog: true },
    });
    if (!image) throw new NotFoundException('Image not found');

    const [remoteUrl] = await this.minimax.generateImages({
      prompt: imagePrompt(image.prompt, image.blog.imageStyle),
      aspectRatio: image.aspectRatio,
      n: 1,
    });
    const url = await this.storage.saveRemoteImage(remoteUrl, blogId);

    const updated = await this.prisma.blogImage.update({
      where: { id: imageId },
      data: { url },
    });

    const blog = image.blog;
    const markdown = (blog.contentMarkdown ?? '').split(image.url).join(url);
    await this.prisma.blog.update({
      where: { id: blogId },
      data: {
        contentMarkdown: markdown,
        contentHtml: markdownToHtml(markdown),
        ...(image.role === 'hero' ? { heroImageUrl: url } : {}),
      },
    });

    return updated;
  }

  async exportBlog(id: string, format: string) {
    const blog = await this.prisma.blog.findUnique({
      where: { id },
      include: { images: true },
    });
    if (!blog) throw new NotFoundException(`Blog ${id} not found`);

    const seo = safeParse<Record<string, unknown>>(blog.seo, {});
    const filenameBase = blog.slug || slugify(blog.title ?? 'article');

    if (format === 'html') {
      return {
        filename: `${filenameBase}.html`,
        contentType: 'text/html; charset=utf-8',
        body: fullHtmlDocument(blog, seo),
      };
    }

    if (format === 'json') {
      return {
        filename: `${filenameBase}.json`,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(
          {
            title: blog.title,
            slug: blog.slug,
            metaTitle: blog.metaTitle,
            metaDescription: blog.metaDescription,
            excerpt: blog.excerpt,
            wordCount: blog.wordCount,
            readingMinutes: blog.readingMinutes,
            heroImageUrl: blog.heroImageUrl,
            markdown: blog.contentMarkdown,
            html: blog.contentHtml,
            images: blog.images,
            seo,
            outline: safeParse(blog.outline, null),
          },
          null,
          2,
        ),
      };
    }

    const frontMatter = [
      '---',
      `title: "${(blog.title ?? '').replace(/"/g, '\\"')}"`,
      `slug: "${blog.slug ?? ''}"`,
      `description: "${(blog.metaDescription ?? '').replace(/"/g, '\\"')}"`,
      `date: "${(blog.completedAt ?? blog.createdAt).toISOString()}"`,
      `tags: [${((seo.tags as string[]) ?? []).map((t) => `"${t}"`).join(', ')}]`,
      blog.heroImageUrl ? `image: "${blog.heroImageUrl}"` : null,
      '---',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    return {
      filename: `${filenameBase}.md`,
      contentType: 'text/markdown; charset=utf-8',
      body: `${frontMatter}\n\n${blog.contentMarkdown ?? ''}`,
    };
  }

  private toSummary(blog: Record<string, any>) {
    return {
      id: blog.id,
      status: blog.status,
      progress: blog.progress,
      currentStep: blog.currentStep,
      topic: blog.topic,
      title: blog.title,
      slug: blog.slug,
      metaTitle: blog.metaTitle,
      metaDescription: blog.metaDescription,
      excerpt: blog.excerpt,
      keywords: safeParse<string[]>(blog.keywords, []),
      wordCount: blog.wordCount,
      readingMinutes: blog.readingMinutes,
      heroImageUrl: blog.heroImageUrl ?? blog.images?.[0]?.url ?? null,
      language: blog.language,
      tone: blog.tone,
      textModel: blog.textModel,
      createdAt: blog.createdAt,
      completedAt: blog.completedAt,
      reviewStatus: blog.reviewStatus,
      reviewNote: blog.reviewNote,
      reviewedAt: blog.reviewedAt,
    };
  }
}

// ------------------------------------------------------------------ helpers

function safeParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => (v ?? '').trim()).filter(Boolean))];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function cleanMarkdown(raw: string): string {
  let md = raw.trim();
  // Models sometimes wrap the whole document in a fence.
  const wrapped = md.match(/^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/);
  if (wrapped) md = wrapped[1];
  return md.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function replaceToken(
  markdown: string,
  token: string,
  url: string | null,
  alt: string,
  caption: string,
): string {
  const replacement = url
    ? `![${alt.replace(/[[\]]/g, '')}](${url}${caption ? ` "${caption.replace(/"/g, "'")}"` : ''})`
    : '';
  if (!markdown.includes(token)) return markdown;
  return markdown.split(token).join(replacement);
}

function headingAnchor(heading: string): string {
  return slugify(heading);
}

function insertTableOfContents(markdown: string): string {
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
  if (headings.length < 3) return markdown;

  const toc = [
    '## Table of Contents',
    '',
    ...headings.map((h) => `- [${h}](#${headingAnchor(h)})`),
    '',
  ].join('\n');

  const firstSection = markdown.search(/^##\s+/m);
  if (firstSection === -1) return markdown;

  return `${markdown.slice(0, firstSection)}${toc}\n${markdown.slice(firstSection)}`;
}

function buildJsonLd(blueprint: Blueprint, words: number, brand?: string | null) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: blueprint.title,
    description: blueprint.metaDescription,
    keywords: [blueprint.primaryKeyword, ...(blueprint.secondaryKeywords ?? [])].join(', '),
    wordCount: words,
    datePublished: new Date().toISOString(),
    author: { '@type': 'Organization', name: brand || 'Editorial Team' },
    publisher: { '@type': 'Organization', name: brand || 'Editorial Team' },
    mainEntity: (blueprint.faq ?? []).length
      ? {
          '@type': 'FAQPage',
          mainEntity: (blueprint.faq ?? []).map((f) => ({
            '@type': 'Question',
            name: f.question,
            acceptedAnswer: { '@type': 'Answer', text: f.answer },
          })),
        }
      : undefined,
  };
}

function fullHtmlDocument(blog: Record<string, any>, seo: Record<string, unknown>): string {
  const esc = (s: string) =>
    (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  return `<!doctype html>
<html lang="${esc(blog.language === 'Arabic' ? 'ar' : 'en')}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(blog.metaTitle ?? blog.title)}</title>
<meta name="description" content="${esc(blog.metaDescription ?? '')}" />
<meta property="og:title" content="${esc((seo.socialTitle as string) ?? blog.title)}" />
<meta property="og:description" content="${esc((seo.socialDescription as string) ?? blog.metaDescription ?? '')}" />
${blog.heroImageUrl ? `<meta property="og:image" content="${esc(blog.heroImageUrl)}" />` : ''}
<meta name="twitter:card" content="summary_large_image" />
<script type="application/ld+json">${JSON.stringify(seo.jsonLd ?? {})}</script>
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#f6faff; color:#0f2540; font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif; }
  article { max-width:760px; margin:0 auto; padding:64px 24px 96px; }
  h1 { font-size:2.6rem; line-height:1.15; letter-spacing:-0.02em; margin:0 0 24px; }
  h2 { font-size:1.7rem; margin:48px 0 16px; letter-spacing:-0.01em; }
  h3 { font-size:1.25rem; margin:32px 0 12px; }
  img { max-width:100%; border-radius:16px; margin:32px 0; box-shadow:0 12px 40px rgba(37,99,235,.12); }
  blockquote { margin:32px 0; padding:16px 24px; border-left:4px solid #60a5fa; background:#eaf3ff; border-radius:0 12px 12px 0; }
  table { width:100%; border-collapse:collapse; margin:24px 0; }
  th,td { padding:12px 14px; border-bottom:1px solid #d9e7fb; text-align:left; }
  th { background:#eaf3ff; }
  code { background:#e8f1ff; padding:2px 6px; border-radius:6px; font-size:.9em; }
  pre { background:#0f2540; color:#e8f1ff; padding:20px; border-radius:14px; overflow:auto; }
  pre code { background:none; color:inherit; }
  a { color:#1d6fe0; }
</style>
</head>
<body>
<article>
${blog.contentHtml ?? ''}
</article>
</body>
</html>`;
}

/**
 * Models occasionally drop or mistype planning fields. Fill every gap so the
 * writing stage always receives a usable blueprint.
 */
function normalizeBlueprint(raw: Blueprint, req: BlueprintRequest): Blueprint {
  const preset = LENGTH_PRESETS[req.lengthPreset] ?? LENGTH_PRESETS.standard;
  const title = (raw?.title ?? '').trim() || req.topic;

  const sections = (Array.isArray(raw?.sections) ? raw.sections : [])
    .filter((s) => s && typeof s.heading === 'string' && s.heading.trim())
    .map((s) => ({
      heading: s.heading.trim(),
      summary: (s.summary ?? '').trim(),
      talkingPoints: Array.isArray(s.talkingPoints) ? s.talkingPoints.filter(Boolean) : [],
      keywords: Array.isArray(s.keywords) ? s.keywords.filter(Boolean) : [],
    }));

  if (!sections.length) {
    sections.push({
      heading: `Understanding ${req.topic}`,
      summary: `Core explanation of ${req.topic}.`,
      talkingPoints: [],
      keywords: req.keywords,
    });
  }

  const primaryKeyword =
    (raw?.primaryKeyword ?? '').trim() || req.keywords[0] || req.topic;

  const imagePrompts = (Array.isArray(raw?.imagePrompts) ? raw.imagePrompts : [])
    .filter((i) => i && typeof i.prompt === 'string' && i.prompt.trim())
    .map((i) => ({
      role: i.role === 'hero' ? ('hero' as const) : ('section' as const),
      sectionIndex: Number.isInteger(i.sectionIndex as number) ? i.sectionIndex : null,
      prompt: i.prompt.trim(),
      alt: (i.alt ?? title).trim(),
      caption: (i.caption ?? '').trim(),
    }));

  // Backfill missing art direction so the requested image count is still honoured.
  while (imagePrompts.length < req.imageCount) {
    const index = imagePrompts.length;
    const section = sections[index % sections.length];
    imagePrompts.push({
      role: index === 0 ? 'hero' : 'section',
      sectionIndex: index === 0 ? null : index % sections.length,
      prompt:
        index === 0
          ? `A bright, airy hero visual representing ${title}, conveying clarity and momentum`
          : `A clean conceptual visual illustrating "${section.heading}"`,
      alt: index === 0 ? title : section.heading,
      caption: '',
    });
  }

  return {
    title,
    slug: slugify(raw?.slug || title),
    metaTitle: (raw?.metaTitle ?? '').trim().slice(0, 60) || title.slice(0, 60),
    metaDescription:
      (raw?.metaDescription ?? '').trim().slice(0, 160) ||
      `A practical guide to ${req.topic} for ${req.audience}.`,
    excerpt: (raw?.excerpt ?? '').trim() || `A practical guide to ${req.topic}.`,
    primaryKeyword,
    secondaryKeywords: Array.isArray(raw?.secondaryKeywords)
      ? dedupe([...raw.secondaryKeywords, ...req.keywords]).slice(0, 12)
      : req.keywords,
    searchIntent: (raw?.searchIntent ?? 'informational').trim(),
    targetWordCount: Number(raw?.targetWordCount) || preset.words,
    sections,
    faq: req.includeFaq && Array.isArray(raw?.faq) ? raw.faq.filter((f) => f?.question) : [],
    imagePrompts,
  };
}

/**
 * Inserts each suggested link at the first eligible occurrence of its anchor.
 * Headings, tables, code, images, and lines that already contain a link are all
 * skipped, so at most one link lands per paragraph and nothing nests.
 */
function applyInternalLinks(
  markdown: string,
  links: InterlinkSuggestion[],
): { markdown: string; applied: number } {
  const lines = markdown.split('\n');
  const usedLines = new Set<number>();
  const usedUrls = new Set<string>();
  let applied = 0;
  let inCode = false;

  // Anything already linked in the draft is off limits.
  for (const existing of markdown.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) {
    usedUrls.add(existing[1]);
  }

  for (const link of links.slice(0, 6)) {
    const anchor = (link?.anchor ?? '').trim();
    const url = (link?.url ?? '').trim();
    if (anchor.length < 4 || !/^https?:\/\//i.test(url) || usedUrls.has(url)) continue;

    inCode = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        inCode = !inCode;
        continue;
      }
      if (inCode) continue;
      if (usedLines.has(i)) continue;
      if (/^\s*(#|>|\||-\s*\[)/.test(line)) continue; // headings, quotes, tables, TOC
      if (line.includes('](')) continue; // already carries a link or an image
      if (!line.includes(anchor)) continue;

      lines[i] = line.replace(anchor, `[${anchor}](${url})`);
      usedLines.add(i);
      usedUrls.add(url);
      applied++;
      break;
    }
  }

  return { markdown: lines.join('\n'), applied };
}
