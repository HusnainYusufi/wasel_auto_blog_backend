/**
 * Pull a JSON object/array out of a model response that may be wrapped in prose,
 * markdown fences, or trailed by explanation. Returns null when nothing parses.
 */
export function extractJson<T>(raw: string): T | null {
  if (!raw) return null;

  const direct = tryParse<T>(raw.trim());
  if (direct) return direct;

  // ```json ... ``` fenced blocks
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = tryParse<T>(fence[1].trim());
    if (fenced) return fenced;
  }

  // First balanced { } or [ ] region in the text.
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = raw.indexOf(open);
    if (start === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const candidate = tryParse<T>(raw.slice(start, i + 1));
          if (candidate) return candidate;
          break;
        }
      }
    }
  }

  return null;
}

function tryParse<T>(text: string): T | null {
  try {
    const value = JSON.parse(text) as T;
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}
