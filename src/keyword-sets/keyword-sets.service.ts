import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateKeywordSetDto, UpdateKeywordSetDto } from './dto/keyword-set.dto';

@Injectable()
export class KeywordSetsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateKeywordSetDto, userId?: string) {
    try {
      const set = await this.prisma.keywordSet.create({
        data: {
          name: dto.name,
          note: dto.note ?? null,
          keywords: JSON.stringify(dto.keywords),
          language: dto.language ?? 'English',
          pinned: dto.pinned ?? false,
          createdById: userId ?? null,
        },
      });
      return toDto(set);
    } catch (err) {
      throw this.translate(err, dto.name);
    }
  }

  /** Pinned first, then most-used, then newest. */
  async findAll() {
    const sets = await this.prisma.keywordSet.findMany({
      orderBy: [{ pinned: 'desc' }, { useCount: 'desc' }, { createdAt: 'desc' }],
    });
    return { total: sets.length, items: sets.map(toDto) };
  }

  async findOne(id: string) {
    const set = await this.prisma.keywordSet.findUnique({ where: { id } });
    if (!set) throw new NotFoundException('Keyword set not found');
    return toDto(set);
  }

  async update(id: string, dto: UpdateKeywordSetDto) {
    await this.findOne(id);

    try {
      const set = await this.prisma.keywordSet.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.note !== undefined ? { note: dto.note || null } : {}),
          ...(dto.keywords !== undefined
            ? { keywords: JSON.stringify(dto.keywords) }
            : {}),
          ...(dto.language !== undefined ? { language: dto.language } : {}),
          ...(dto.pinned !== undefined ? { pinned: dto.pinned } : {}),
        },
      });
      return toDto(set);
    } catch (err) {
      throw this.translate(err, dto.name ?? '');
    }
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.keywordSet.delete({ where: { id } });
    return { id, deleted: true };
  }

  /**
   * Records that a set was used in a generation. Failures are swallowed: a lost
   * usage counter must never take down the generation that triggered it.
   */
  async recordUse(ids: string[]): Promise<void> {
    if (!ids.length) return;

    try {
      await this.prisma.keywordSet.updateMany({
        where: { id: { in: ids } },
        data: { useCount: { increment: 1 } },
      });
    } catch {
      /* non-critical */
    }
  }

  /** Flattens the named sets into a deduplicated keyword list. */
  async resolveKeywords(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];

    const sets = await this.prisma.keywordSet.findMany({
      where: { id: { in: ids } },
    });

    const seen = new Set<string>();
    const out: string[] = [];

    for (const set of sets) {
      for (const keyword of safeParse<string[]>(set.keywords, [])) {
        const key = keyword.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(keyword);
      }
    }

    return out;
  }

  private translate(err: unknown, name: string) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException(`A keyword set named "${name}" already exists`);
    }
    return err;
  }
}

function toDto(set: {
  id: string;
  name: string;
  note: string | null;
  keywords: string;
  language: string;
  pinned: boolean;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: set.id,
    name: set.name,
    note: set.note,
    keywords: safeParse<string[]>(set.keywords, []),
    language: set.language,
    pinned: set.pinned,
    useCount: set.useCount,
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
  };
}

function safeParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
