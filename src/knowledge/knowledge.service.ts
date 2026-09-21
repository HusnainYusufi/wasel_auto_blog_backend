import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { URL } from 'url';
import { PrismaService } from '../prisma/prisma.service';
import { TextProviderRegistry } from '../providers/text-provider.registry';
import { httpRequestRaw } from '../common/http.util';
import { discoverArticleLinks, extractPage } from './html-extract.util';
import {
  CorpusEntry,
  KnowledgeProfileResult,
  profilePrompt,
} from './knowledge.prompts';

const MAX_STORED_CHARS = 20_000;
const PROFILE_ID = 'default';

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly textProviders: TextProviderRegistry,
  ) {}

  // ----------------------------------------------------------------- ingest

  /**
   * Queue URLs for crawling. When `discoverLinks` is set, each URL is also
   * treated as a listing page and same-domain article links are pulled in.
   */
  async addSources(params: {
    urls: string[];
    discoverLinks?: boolean;
    maxPages?: number;
  }) {
    const normalized = params.urls
      .map((url) => this.normalizeUrl(url))
      .filter((url): url is string => Boolean(url));

    if (!normalized.length) {
      throw new BadRequestException('No valid http(s) URLs were provided.');
    }

    const unique = [...new Set(normalized)];
    const created: string[] = [];

    for (const url of unique) {
      const existing = await this.prisma.knowledgeSource.findUnique({ where: { url } });
      if (existing) continue;
      const source = await this.prisma.knowledgeSource.create({ data: { url } });
      created.push(source.id);
    }

    void this.processQueue({
      seeds: unique,
      discoverLinks: params.discoverLinks ?? false,
      maxPages: Math.min(Math.max(params.maxPages ?? 10, 1), 40),
    }).catch((err) =>
      this.logger.error(`Knowledge crawl failed: ${(err as Error).message}`),
    );

    return { queued: unique.length, created: created.length };
  }

  private async processQueue(params: {
    seeds: string[];
    discoverLinks: boolean;
    maxPages: number;
  }) {
    let budget = params.maxPages;

    for (const seed of params.seeds) {
      const html = await this.crawlOne(seed);

      if (params.discoverLinks && html) {
        const links = discoverArticleLinks(html, seed, budget);
        let adopted = 0;

        for (const link of links) {
          if (budget <= 0) break;
          const normalized = this.normalizeUrl(link);
          if (!normalized) continue;

          const existing = await this.prisma.knowledgeSource.findUnique({
            where: { url: normalized },
          });
          if (existing) continue;

          await this.prisma.knowledgeSource.create({
            data: { url: normalized, discoveredFrom: seed },
          });
          await this.crawlOne(normalized);
          adopted++;
          budget--;
        }

        // The seed was an index, not an article — keep only what it pointed to.
        if (adopted > 0) {
          await this.prisma.knowledgeSource.deleteMany({
            where: { url: seed, discoveredFrom: null },
          });
        }
      }
    }

    await this.markProfileStale();
  }

  /** Fetch and extract one page. Returns the raw HTML so links can be discovered. */
  private async crawlOne(url: string): Promise<string | null> {
    const source = await this.prisma.knowledgeSource.findUnique({ where: { url } });
    if (!source) return null;

    try {
      const res = await httpRequestRaw(url, {
        timeoutMs: 45_000,
        headers: {
          // Some hosts serve a bot wall to unknown agents.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}`);
      }

      const contentType = String(res.headers['content-type'] ?? '');
      if (contentType && !/html|xml|text/i.test(contentType)) {
        throw new Error(`Unsupported content type: ${contentType.split(';')[0]}`);
      }

      const html = res.body.toString('utf8');
      const page = extractPage(html);

      if (page.wordCount < 60) {
        throw new Error('Not enough readable text on the page');
      }

      await this.prisma.knowledgeSource.update({
        where: { id: source.id },
        data: {
          status: 'ready',
          title: page.title || url,
          siteName: page.siteName || new URL(url).hostname,
          description: page.description,
          headings: JSON.stringify(page.headings),
          content: page.text.slice(0, MAX_STORED_CHARS),
          wordCount: page.wordCount,
          error: null,
          fetchedAt: new Date(),
        },
      });

      return html;
    } catch (err) {
      const message = (err as Error).message ?? 'Crawl failed';
      this.logger.warn(`Could not crawl ${url}: ${message}`);
      await this.prisma.knowledgeSource.update({
        where: { id: source.id },
        data: { status: 'failed', error: message, fetchedAt: new Date() },
      });
      return null;
    }
  }

  /** Reject non-http(s) schemes and loopback/private hosts. */
  private normalizeUrl(input: string): string | null {
    const trimmed = (input ?? '').trim();
    if (!trimmed) return null;

    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
      return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const host = parsed.hostname.toLowerCase();
    const isPrivate =
      host === 'localhost' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (isPrivate) return null;

    parsed.hash = '';
    return parsed.toString();
  }

  // ---------------------------------------------------------------- profile

  async rebuildProfile() {
    const sources = await this.prisma.knowledgeSource.findMany({
      where: { status: 'ready' },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });

    if (!sources.length) {
      throw new BadRequestException(
        'Add at least one crawlable URL before building the profile.',
      );
    }

    const corpus: CorpusEntry[] = sources.map((s) => ({
      title: s.title ?? s.url,
      url: s.url,
      description: s.description ?? '',
      headings: safeParse<string[]>(s.headings, []),
      excerpt: (s.content ?? '').slice(0, 1200),
    }));

    const result = await this.textProviders
      .defaultProvider()
      .chatJson<KnowledgeProfileResult>(profilePrompt(corpus), {
        temperature: 0.5,
        maxTokens: 6000,
      });

    const data = {
      niche: result.niche ?? '',
      audience: result.audience ?? '',
      toneSummary: result.toneSummary ?? '',
      styleNotes: JSON.stringify(result.styleNotes ?? []),
      recurringThemes: JSON.stringify(result.recurringThemes ?? []),
      coveredTopics: JSON.stringify(result.coveredTopics ?? []),
      contentGaps: JSON.stringify(result.contentGaps ?? []),
      suggestedTopics: JSON.stringify(result.suggestedTopics ?? []),
      sourceCount: sources.length,
      stale: false,
      generatedAt: new Date(),
    };

    await this.prisma.knowledgeProfile.upsert({
      where: { id: PROFILE_ID },
      create: { id: PROFILE_ID, ...data },
      update: data,
    });

    return this.getProfile();
  }

  async getProfile() {
    const profile = await this.prisma.knowledgeProfile.findUnique({
      where: { id: PROFILE_ID },
    });
    const readyCount = await this.prisma.knowledgeSource.count({
      where: { status: 'ready' },
    });

    if (!profile) {
      return { exists: false, readyCount, stale: true };
    }

    return {
      exists: true,
      readyCount,
      stale: profile.stale,
      niche: profile.niche,
      audience: profile.audience,
      toneSummary: profile.toneSummary,
      styleNotes: safeParse<string[]>(profile.styleNotes, []),
      recurringThemes: safeParse<string[]>(profile.recurringThemes, []),
      coveredTopics: safeParse<string[]>(profile.coveredTopics, []),
      contentGaps: safeParse<string[]>(profile.contentGaps, []),
      suggestedTopics: safeParse<
        Array<{ title: string; angle: string; keywords: string[] }>
      >(profile.suggestedTopics, []),
      sourceCount: profile.sourceCount,
      generatedAt: profile.generatedAt,
    };
  }

  private async markProfileStale() {
    await this.prisma.knowledgeProfile.updateMany({
      where: { id: PROFILE_ID },
      data: { stale: true },
    });
  }

  // ------------------------------------------------------------------ reads

  async list() {
    const items = await this.prisma.knowledgeSource.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return {
      total: items.length,
      ready: items.filter((i) => i.status === 'ready').length,
      pending: items.filter((i) => i.status === 'pending').length,
      failed: items.filter((i) => i.status === 'failed').length,
      items: items.map((i) => ({
        id: i.id,
        url: i.url,
        status: i.status,
        title: i.title,
        siteName: i.siteName,
        description: i.description,
        headings: safeParse<string[]>(i.headings, []),
        wordCount: i.wordCount,
        error: i.error,
        discoveredFrom: i.discoveredFrom,
        fetchedAt: i.fetchedAt,
        createdAt: i.createdAt,
      })),
    };
  }

  async remove(id: string) {
    const source = await this.prisma.knowledgeSource.findUnique({ where: { id } });
    if (!source) throw new NotFoundException('Source not found');
    await this.prisma.knowledgeSource.delete({ where: { id } });
    await this.markProfileStale();
    return { id, deleted: true };
  }

  async recrawl(id: string) {
    const source = await this.prisma.knowledgeSource.findUnique({ where: { id } });
    if (!source) throw new NotFoundException('Source not found');

    await this.prisma.knowledgeSource.update({
      where: { id },
      data: { status: 'pending', error: null },
    });
    await this.crawlOne(source.url);
    await this.markProfileStale();

    return this.prisma.knowledgeSource.findUnique({ where: { id } });
  }

  async clear() {
    const { count } = await this.prisma.knowledgeSource.deleteMany({});
    await this.prisma.knowledgeProfile.deleteMany({});
    return { deleted: count };
  }

  // ------------------------------------------------- context for generation

  /**
   * Condensed knowledge-base briefing injected into the generation prompts:
   * house style to imitate, ground already covered, and real URLs to link to.
   */
  async buildContext(sourceIds?: string[]): Promise<KnowledgeContext | null> {
    const sources = await this.prisma.knowledgeSource.findMany({
      where: {
        status: 'ready',
        ...(sourceIds?.length ? { id: { in: sourceIds } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    if (!sources.length) return null;

    const profile = await this.prisma.knowledgeProfile.findUnique({
      where: { id: PROFILE_ID },
    });

    return {
      sourceIds: sources.map((s) => s.id),
      niche: profile?.niche ?? '',
      audience: profile?.audience ?? '',
      toneSummary: profile?.toneSummary ?? '',
      styleNotes: safeParse<string[]>(profile?.styleNotes ?? '[]', []),
      coveredTopics: safeParse<string[]>(profile?.coveredTopics ?? '[]', []),
      existingArticles: sources.map((s) => ({
        title: s.title ?? s.url,
        url: s.url,
        summary: (s.description || (s.content ?? '').slice(0, 200)).trim(),
      })),
    };
  }
}

export interface KnowledgeContext {
  sourceIds: string[];
  niche: string;
  audience: string;
  toneSummary: string;
  styleNotes: string[];
  coveredTopics: string[];
  existingArticles: Array<{ title: string; url: string; summary: string }>;
}

function safeParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
