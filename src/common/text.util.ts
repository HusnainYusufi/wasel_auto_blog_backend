export function slugify(input: string): string {
  return (input || 'untitled')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^-|-$/g, '') || 'untitled';
}

export function countWords(markdown: string): number {
  if (!markdown) return 0;
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*_`~\-|]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 225));
}

/** Density of each keyword as a percentage of total words. */
export function keywordDensity(
  markdown: string,
  keywords: string[],
): Array<{ keyword: string; count: number; density: number }> {
  const words = countWords(markdown) || 1;
  const haystack = markdown.toLowerCase();

  return keywords.map((keyword) => {
    const needle = keyword.toLowerCase().trim();
    if (!needle) return { keyword, count: 0, density: 0 };
    const matches = haystack.split(needle).length - 1;
    return {
      keyword,
      count: matches,
      density: Number(((matches * needle.split(/\s+/).length * 100) / words).toFixed(2)),
    };
  });
}
