import { URL } from 'url';

export interface ExtractedPage {
  title: string;
  siteName: string;
  description: string;
  headings: string[];
  text: string;
  wordCount: number;
}

/** Blocks that never contain article prose. */
const NOISE_TAGS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'form',
  'nav',
  'header',
  'footer',
  'aside',
  'template',
];

/** Tags that imply a line break once markup is stripped. */
const BLOCK_TAGS =
  'address|article|aside|blockquote|br|div|dd|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
};

export function extractPage(html: string): ExtractedPage {
  const title =
    matchOne(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    decode(stripTags(matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i))) ||
    decode(stripTags(matchOne(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)));

  const siteName =
    matchOne(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);

  const description =
    matchOne(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    matchOne(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);

  const cleaned = stripNoise(html);
  const main = pickMainRegion(cleaned);

  const headings = [...main.matchAll(/<h([2-3])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => decode(stripTags(m[2])).trim())
    .filter((h) => h.length > 2 && h.length < 160)
    .slice(0, 40);

  const text = htmlToText(main);

  return {
    title: decode(title).trim(),
    siteName: decode(siteName).trim(),
    description: decode(description).trim(),
    headings,
    text,
    wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
  };
}

/**
 * Same-origin links that look like individual articles — used when a listing or
 * blog index page is submitted instead of a single post.
 */
export function discoverArticleLinks(html: string, baseUrl: string, limit = 12): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const skip =
    /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|mp3|css|js)(\?|$)|^(mailto:|tel:|javascript:)|\/(tag|tags|category|categories|author|page|search|login|signup|privacy|terms|contact|about|feed|rss)(\/|$|\?)/i;

  const found = new Map<string, true>();

  for (const match of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    const raw = match[1].trim();
    if (!raw || skip.test(raw)) continue;

    let resolved: URL;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }

    if (resolved.hostname !== base.hostname) continue;
    if (resolved.pathname === base.pathname) continue;

    // Article URLs carry a real slug rather than a bare section path.
    const segments = resolved.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    if (!segments.length || last.length < 8 || !/[a-z]/i.test(last)) continue;

    resolved.hash = '';
    resolved.search = '';
    found.set(resolved.toString(), true);
    if (found.size >= limit) break;
  }

  return [...found.keys()];
}

// ------------------------------------------------------------------ internals

function matchOne(html: string, pattern: RegExp): string {
  return html.match(pattern)?.[1] ?? '';
}

function stripNoise(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of NOISE_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }
  return out;
}

/** Prefer the semantic article container; fall back to the largest candidate. */
function pickMainRegion(html: string): string {
  for (const pattern of [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<div[^>]+(?:class|id)=["'][^"']*(?:post-content|entry-content|article-body|blog-content|content-body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  ]) {
    const regions = [...html.matchAll(pattern)].map((m) => m[1]);
    if (regions.length) {
      return regions.reduce((a, b) => (textLength(b) > textLength(a) ? b : a));
    }
  }

  return matchOne(html, /<body\b[^>]*>([\s\S]*)<\/body>/i) || html;
}

function textLength(html: string): number {
  return stripTags(html).replace(/\s+/g, ' ').trim().length;
}

function htmlToText(html: string): string {
  return decode(
    html
      .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(html: string): string {
  return (html ?? '').replace(/<[^>]+>/g, ' ');
}

function decode(text: string): string {
  return (text ?? '')
    .replace(/&#(\d+);/g, (_m, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
