/**
 * Arabic -> Latin transliteration for URL slugs.
 *
 * Aimed at readable, stable ASCII slugs rather than scholarly accuracy: no
 * diacritics, no digraph collisions with the separator, and deterministic so
 * the same title always yields the same slug.
 */

/** Definite article, stripped when it opens a word ("السرير" -> "sryr"). */
const DEFINITE_ARTICLE = /^ال/;

const ARABIC_MAP: Record<string, string> = {
  // Hamza family — all collapse to a plain vowel carrier.
  'ء': 'a', 'آ': 'a', 'أ': 'a', 'إ': 'i', 'ؤ': 'u', 'ئ': 'i',
  // Consonants
  'ا': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h',
  'خ': 'kh', 'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z', 'س': 's',
  'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a',
  'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm',
  'ن': 'n', 'ه': 'h', 'و': 'w', 'ي': 'y', 'ى': 'a', 'ة': 'h',
  // Persian/Urdu letters that appear in Arabic-script content
  'پ': 'p', 'چ': 'ch', 'ژ': 'zh', 'گ': 'g', 'ک': 'k', 'ی': 'y',
  // Arabic-Indic digits
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/** Short-vowel and shadda marks carry no value in a slug. */
const ARABIC_DIACRITICS = /[ً-ٰٟۖ-ۭـ]/g;

export function hasArabic(text: string): boolean {
  return /[؀-ۿݐ-ݿ]/.test(text ?? '');
}

/** Transliterates Arabic runs and leaves everything else untouched. */
export function transliterateArabic(input: string): string {
  if (!input) return '';

  return input
    .replace(ARABIC_DIACRITICS, '')
    .split(/(\s+)/)
    .map((token) => {
      if (!hasArabic(token)) return token;

      const stripped = token.replace(DEFINITE_ARTICLE, '');
      // Never let article-stripping erase the word entirely.
      const source = stripped.length ? stripped : token;

      return [...source].map((ch) => ARABIC_MAP[ch] ?? ch).join('');
    })
    .join('');
}
