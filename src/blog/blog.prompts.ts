import { ChatMessage } from '../minimax/minimax.types';
import type { KnowledgeContext } from '../knowledge/knowledge.service';

export const LENGTH_PRESETS: Record<
  string,
  { label: string; words: number; sections: number }
> = {
  brief: { label: 'Brief', words: 800, sections: 4 },
  standard: { label: 'Standard', words: 1500, sections: 6 },
  indepth: { label: 'In-depth', words: 2400, sections: 8 },
  pillar: { label: 'Pillar', words: 3200, sections: 10 },
};

export interface BlueprintRequest {
  topic: string;
  keywords: string[];
  language: string;
  tone: string;
  audience: string;
  lengthPreset: string;
  pointOfView: string;
  brandName?: string;
  callToAction?: string;
  includeFaq: boolean;
  imageCount: number;
  imageStyle: string;
  /** Briefing derived from previously published articles, when enabled. */
  knowledge?: KnowledgeContext | null;
}

export interface BlueprintSection {
  heading: string;
  summary: string;
  talkingPoints: string[];
  keywords: string[];
}

export interface BlueprintImage {
  role: 'hero' | 'section';
  sectionIndex: number | null;
  prompt: string;
  alt: string;
  caption: string;
}

export interface Blueprint {
  title: string;
  slug: string;
  metaTitle: string;
  metaDescription: string;
  excerpt: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  searchIntent: string;
  targetWordCount: number;
  sections: BlueprintSection[];
  faq: Array<{ question: string; answer: string }>;
  imagePrompts: BlueprintImage[];
}

export interface SeoPack {
  seoScore: number;
  tags: string[];
  categories: string[];
  socialTitle: string;
  socialDescription: string;
  twitterPost: string;
  linkedinPost: string;
  internalLinkIdeas: string[];
  improvementTips: string[];
}

const EDITOR_PERSONA =
  'You are a senior content strategist and SEO editor who has shipped thousands of top-ranking articles. You write with genuine expertise, concrete detail, and zero filler. You never pad with phrases like "in today\'s fast-paced world", "delve into", "it is important to note", or "in conclusion".';


/**
 * Renders the knowledge-base briefing shared by every stage: the house style to
 * imitate, the ground already covered, and the real URLs available for linking.
 */
function knowledgeBlock(knowledge?: KnowledgeContext | null): string {
  if (!knowledge) return '';

  const articles = knowledge.existingArticles
    .slice(0, 15)
    .map((a) => `- "${a.title}" (${a.url})${a.summary ? ` — ${a.summary.slice(0, 160)}` : ''}`)
    .join('\n');

  return `
KNOWLEDGE BASE — this blog's existing published work
${knowledge.niche ? `Niche: ${knowledge.niche}` : ''}
${knowledge.audience ? `Established audience: ${knowledge.audience}` : ''}
${knowledge.toneSummary ? `House voice: ${knowledge.toneSummary}` : ''}
${knowledge.styleNotes.length ? `House conventions to follow:\n${knowledge.styleNotes.map((n) => `  - ${n}`).join('\n')}` : ''}
${knowledge.coveredTopics.length ? `Already covered (do NOT re-explain at length): ${knowledge.coveredTopics.join(', ')}` : ''}

Previously published articles:
${articles}

Use this to match the established voice, stay inside the niche, and take an angle the existing posts have not already taken. Do not add links to those articles yourself — that is handled separately.
`;
}

export function blueprintPrompt(req: BlueprintRequest): ChatMessage[] {
  const preset = LENGTH_PRESETS[req.lengthPreset] ?? LENGTH_PRESETS.standard;
  const sectionImages = Math.max(0, req.imageCount - 1);

  return [
    { role: 'system', content: EDITOR_PERSONA },
    {
      role: 'user',
      content: `Plan a search-optimized blog article and return it as JSON.
${knowledgeBlock(req.knowledge)}
TOPIC: ${req.topic}
TARGET KEYWORDS: ${req.keywords.length ? req.keywords.join(', ') : '(derive the best keywords yourself from the topic)'}
LANGUAGE: ${req.language} (write every field in this language, except "slug" which stays lowercase ASCII)
TONE: ${req.tone}
AUDIENCE: ${req.audience}
POINT OF VIEW: ${req.pointOfView}
TARGET LENGTH: about ${preset.words} words across ${preset.sections} H2 sections
${req.brandName ? `BRAND: ${req.brandName} — reference it naturally, never as an advert.` : ''}
${req.callToAction ? `CLOSING CALL TO ACTION: ${req.callToAction}` : ''}

PLANNING RULES
- The title must be specific and clickable, 50-65 characters, and contain the primary keyword.
- metaTitle <= 60 characters. metaDescription 140-155 characters, ends with a reason to click.
- Every section heading must be scannable and benefit-driven, not a generic label like "Introduction" or "Overview".
- Sections must progress logically and never repeat one another. Each needs 3-5 concrete talking points a writer can expand without inventing statistics.
- searchIntent is one of: informational, commercial, transactional, navigational.
${req.includeFaq ? '- Include 4-6 FAQ entries targeting real long-tail questions, each with a 40-60 word answer.' : '- Return an empty faq array.'}

IMAGE ART DIRECTION
- Produce exactly ${req.imageCount} entries in imagePrompts: 1 with role "hero" (sectionIndex null) and ${sectionImages} with role "section".
- Each section image must use a distinct sectionIndex (0-based index into the sections array), spread across the article.
- Every prompt is a standalone text-to-image prompt of 40-70 words in the style "${req.imageStyle}": describe subject, composition, lighting, colour palette and mood. Favour a clean palette built around white and light blue.
- Never request embedded text, letters, logos, watermarks, charts, or recognisable real people in an image.
- "alt" is descriptive accessible alt text under 125 characters. "caption" is a short editorial caption.

Return exactly this JSON shape:
{
  "title": string,
  "slug": string,
  "metaTitle": string,
  "metaDescription": string,
  "excerpt": string,
  "primaryKeyword": string,
  "secondaryKeywords": string[],
  "searchIntent": string,
  "targetWordCount": number,
  "sections": [{ "heading": string, "summary": string, "talkingPoints": string[], "keywords": string[] }],
  "faq": [{ "question": string, "answer": string }],
  "imagePrompts": [{ "role": "hero" | "section", "sectionIndex": number | null, "prompt": string, "alt": string, "caption": string }]
}`,
    },
  ];
}

export function articlePrompt(
  req: BlueprintRequest,
  blueprint: Blueprint,
  imageTokens: Array<{ token: string; sectionIndex: number | null; role: string }>,
): ChatMessage[] {
  const preset = LENGTH_PRESETS[req.lengthPreset] ?? LENGTH_PRESETS.standard;

  const outline = blueprint.sections
    .map(
      (s, i) =>
        `${i + 1}. ${s.heading}\n   Angle: ${s.summary}\n   Cover: ${(s.talkingPoints ?? []).join('; ')}\n   Weave in: ${(s.keywords ?? []).join(', ') || '—'}`,
    )
    .join('\n');

  const sectionTokens = imageTokens.filter((t) => t.role === 'section');
  const tokenInstructions = sectionTokens.length
    ? sectionTokens
        .map(
          (t) =>
            `- Place ${t.token} on its own line inside section ${(t.sectionIndex ?? 0) + 1} ("${blueprint.sections[t.sectionIndex ?? 0]?.heading ?? ''}"), after its first paragraph.`,
        )
        .join('\n')
    : '- No inline image tokens are needed.';

  return [
    { role: 'system', content: EDITOR_PERSONA },
    {
      role: 'user',
      content: `Write the complete article in Markdown, in ${req.language}.
${knowledgeBlock(req.knowledge)}
TITLE: ${blueprint.title}
PRIMARY KEYWORD: ${blueprint.primaryKeyword}
SECONDARY KEYWORDS: ${(blueprint.secondaryKeywords ?? []).join(', ')}
TONE: ${req.tone} | AUDIENCE: ${req.audience} | VOICE: ${req.pointOfView}
LENGTH: ${preset.words} words (+/- 15%)

OUTLINE TO FOLLOW EXACTLY
${outline}

STRUCTURE
- Start with the H1: "# ${blueprint.title}".
- Follow with a 60-90 word hook that names the reader's problem and promises the payoff. No heading above it.
- Then one "## " section per outline item, in order, using the exact headings given.
- Use "### " subheadings, bullet lists, numbered steps, bold key terms, and at least one Markdown table where it genuinely helps comprehension.
- Include one short blockquote with a memorable insight.
${req.includeFaq && blueprint.faq?.length ? '- Add a "## Frequently Asked Questions" section near the end with each question as a "### " subheading.' : ''}
${req.callToAction ? `- Close with a "## " section that delivers this call to action naturally: ${req.callToAction}` : '- Close with a section that gives the reader a concrete next step.'}

IMAGE PLACEHOLDERS
${tokenInstructions}
- Write the token exactly as given, alone on its line, with a blank line above and below. Do not write Markdown image syntax yourself.

SEO RULES
- The primary keyword appears in the H1, in the first 100 words, in at least two H2s, and 4-8 times in the body — always naturally, never stuffed.
- Vary sentence length. Keep paragraphs to 2-4 sentences.
- Be concrete: name techniques, trade-offs, and examples. Never invent statistics, studies, dates, prices, or quotes from real people.
- Do not include a meta description, front-matter, or any commentary about the writing task.

Output raw Markdown only — no code fence around the whole document.`,
    },
  ];
}

export function seoPackPrompt(
  req: BlueprintRequest,
  blueprint: Blueprint,
  markdown: string,
): ChatMessage[] {
  return [
    { role: 'system', content: EDITOR_PERSONA },
    {
      role: 'user',
      content: `Audit this finished article and return a JSON distribution pack. Write text fields in ${req.language}.

TITLE: ${blueprint.title}
PRIMARY KEYWORD: ${blueprint.primaryKeyword}

ARTICLE (truncated):
"""
${markdown.slice(0, 12000)}
"""
${
  req.knowledge?.existingArticles.length
    ? `\nFor "internalLinkIdeas", pick only from these real published articles and return each as \`Anchor text — URL\`:\n${req.knowledge.existingArticles
        .slice(0, 15)
        .map((a) => `- ${a.title} — ${a.url}`)
        .join('\n')}\n`
    : ''
}

Return exactly:
{
  "seoScore": number,            // 0-100, honest assessment of on-page SEO strength
  "tags": string[],              // 6-10 lowercase tags
  "categories": string[],        // 1-3 broad categories
  "socialTitle": string,         // <= 70 chars, Open Graph title
  "socialDescription": string,   // <= 200 chars
  "twitterPost": string,         // <= 260 chars, hook + 2-3 hashtags
  "linkedinPost": string,        // 60-100 words, professional, ends with a question
  "internalLinkIdeas": string[], // 4-6 internal links worth adding
  "improvementTips": string[]    // 3-5 specific, actionable ranking improvements
}`,
    },
  ];
}

export function imagePrompt(base: string, style: string): string {
  return `${base}. Style: ${style}. Clean bright composition, airy white and soft light-blue palette, natural light, high detail, professional editorial quality, no text, no letters, no logos, no watermarks.`;
}

export interface InterlinkSuggestion {
  anchor: string;
  url: string;
  /** Forces the model to justify the match, which suppresses weak links. */
  reason?: string;
}

/**
 * Asks only one question — which exact phrases in the finished draft should link
 * where — so the insertion itself can be done deterministically in code.
 */
export function interlinkPrompt(
  markdown: string,
  articles: Array<{ title: string; url: string; summary: string }>,
): ChatMessage[] {
  const catalogue = articles
    .slice(0, 12)
    .map((a) => `- ${a.url}\n  Title: ${a.title}${a.summary ? `\n  About: ${a.summary.slice(0, 140)}` : ''}`)
    .join('\n');

  return [
    {
      role: 'system',
      content:
        'You place internal links in finished articles. You only ever choose phrases that already exist verbatim in the text.',
    },
    {
      role: 'user',
      content: `Choose 0-3 internal links to add to this article. Quality matters far more than quantity — returning one strong link, or none at all, is a better answer than three weak ones.

ARTICLE:
"""
${markdown.slice(0, 14000)}
"""

AVAILABLE INTERNAL PAGES:
${catalogue}

Rules:
- "anchor" MUST be copied character-for-character from a body paragraph of the article above. Do not paraphrase, reword, fix capitalisation, or invent a phrase.
- Choose anchors of 3-8 words that read naturally as link text and genuinely relate to the linked page.
- Never choose text from a heading, a list of contents, a table, or an existing link.
- Use each URL at most once.
- RELEVANCE TEST: the anchor must be about the same specific subject as the linked page. A reader clicking it must land on exactly what the phrase promised. Loose thematic overlap is NOT enough — skip it.
- "reason" must name the concrete subject both the anchor and the page share. If you cannot state one specific shared subject, do not include that link.
- If nothing passes the test, return an empty array.

Return exactly:
{ "links": [{ "anchor": string, "url": string, "reason": string }] }`,
    },
  ];
}
