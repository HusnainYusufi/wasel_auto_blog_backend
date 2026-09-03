import { ChatMessage } from '../minimax/minimax.types';

export interface KnowledgeProfileResult {
  niche: string;
  audience: string;
  toneSummary: string;
  styleNotes: string[];
  recurringThemes: string[];
  coveredTopics: string[];
  contentGaps: string[];
  suggestedTopics: Array<{ title: string; angle: string; keywords: string[] }>;
}

export interface CorpusEntry {
  title: string;
  url: string;
  description: string;
  headings: string[];
  excerpt: string;
}

export function profilePrompt(corpus: CorpusEntry[]): ChatMessage[] {
  const digest = corpus
    .map(
      (entry, index) =>
        `${index + 1}. "${entry.title}"\n   URL: ${entry.url}\n   Summary: ${entry.description || '—'}\n   Sections: ${entry.headings.slice(0, 8).join(' | ') || '—'}\n   Excerpt: ${entry.excerpt.slice(0, 700)}`,
    )
    .join('\n\n');

  return [
    {
      role: 'system',
      content:
        'You are a content strategist auditing an existing blog. You read what has already been published and infer the publication\'s niche, house style, and the gaps worth filling next. You are specific and never generic.',
    },
    {
      role: 'user',
      content: `Below are ${corpus.length} articles already published on this blog. Analyse them and return JSON.

${digest}

Rules:
- "niche" is one precise sentence naming the subject area and the angle this blog takes on it.
- "audience" names who these posts are written for, concretely.
- "toneSummary" describes the writing voice in one or two sentences (formality, person, sentence rhythm, use of examples).
- "styleNotes": 4-6 concrete, imitable conventions you can observe — heading style, article length, how posts open and close, formatting habits, vocabulary. Each must be actionable for a writer.
- "recurringThemes": 4-8 subjects this blog returns to.
- "coveredTopics": short labels for ground already covered, so a writer knows what NOT to repeat.
- "contentGaps": 3-6 clear gaps or unanswered questions given what exists.
- "suggestedTopics": 6 new article ideas that fit the niche and fill those gaps. Each has a specific clickable "title", a one-sentence "angle", and 2-4 "keywords". Never duplicate an existing article.

Return exactly:
{
  "niche": string,
  "audience": string,
  "toneSummary": string,
  "styleNotes": string[],
  "recurringThemes": string[],
  "coveredTopics": string[],
  "contentGaps": string[],
  "suggestedTopics": [{ "title": string, "angle": string, "keywords": string[] }]
}`,
    },
  ];
}
