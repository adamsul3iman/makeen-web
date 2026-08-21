/**
 * Smart Arabic text normalization for forgiving search.
 *
 * Strips tashkeel and normalizes the common Arabic letter variants so a
 * query like "أحمد" matches "احمد", "اية" matches "آية", and "ة"/"ه"
 * collapse to the same letter. Applied consistently on both the query and
 * the indexed name so comparisons are always apples-to-apples.
 *
 * The result is also NFC/NFKC-folded and lowercased, so callers can use it
 * directly for `includes`/`startsWith` matching without extra casing work.
 */
const ARABIC_NORMALIZATION: Array<[RegExp, string]> = [
  // Tashkeel + tatweel + superscript alef (نْ نٌ نَ ـ أل)
  [/[\u064B-\u065F\u0670]/g, ""],
  // أ إ آ ا -> ا
  [/[\u0622\u0623\u0625\u0627]/g, "\u0627"],
  // ة ه -> ه
  [/[\u0629\u0647]/g, "\u0647"],
  // ى ي -> ي
  [/[\u0649\u064A]/g, "\u064A"],
];

export function normalizeArabicText(value: string): string {
  let out = String(value ?? "").normalize("NFKC").toLowerCase();
  for (const [pattern, replacement] of ARABIC_NORMALIZATION) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
