// Matching a speech recogniser's transcript against the words of the mushaf.
//
// Recognisers write modern spelling without diacritics, and often merge or split
// words ("يا أيها" / "يأيها"), drop or add a word, or mishear one. So the
// comparison is on normalised plain spelling with some tolerance, and the
// alignment walks both sequences greedily, classifying each expected word as
// recited, skipped or wrong.

export type WordStatus = 'ok' | 'missed' | 'wrong';

export interface Alignment {
  /** Index of the next expected word not yet accounted for. */
  cursor: number;
  /** Status of every expected word the transcript covered, by index. */
  statuses: Map<number, WordStatus>;
}

const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const NON_ARABIC = /[^\u0621-\u064A\s]/g;

/** Plain comparable form: no diacritics or tatweel, one form of alef, ya, ta marbuta, hamza carriers. */
export function normalize(text: string): string {
  return text
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(NON_ARABIC, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  return normalize(text).split(/\s+/).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/**
 * Same word, allowing for recogniser spelling noise that normalising doesn't
 * remove. Words up to 7 letters must match exactly, since one letter is often
 * the whole difference between two real words, and exactly the kind of slip a
 * memoriser makes (لليسرى / للعسرى, يغشى / يغطى, من / ما). Longer words may
 * differ by one letter.
 */
export function sameWord(expected: string, heard: string): boolean {
  if (expected === heard) return true;
  const len = Math.max(expected.length, heard.length);
  return len >= 8 && levenshtein(expected, heard) <= 1;
}

// How far ahead to look for the next matching word when the reciter skipped
// words (expected side) or the recogniser inserted some (heard side).
const SKIP_AHEAD = 3;
const EXTRA_AHEAD = 2;
// How far back a repeated phrase may start.
const REPEAT_BACK = 8;

/** Number of heard words from `i` that re-say expected words ending just before `j`, or 0. */
function repetitionLength(expected: string[], j: number, heard: string[], i: number): number {
  for (let back = 1; back <= REPEAT_BACK && j - back >= 0; back++) {
    if (!sameWord(expected[j - back], heard[i])) continue;
    let n = 1;
    while (n < back && i + n < heard.length && sameWord(expected[j - back + n], heard[i + n])) n++;
    const reachesEndOfHeard = i + n === heard.length;
    if (n >= 2 || reachesEndOfHeard) return n;
  }
  return 0;
}

/**
 * Align heard tokens against `expected` (normalised words) starting at `from`.
 * The last heard token may still be mid-word, so an unmatched last token is
 * left pending rather than judged.
 */
export function align(expected: string[], from: number, heard: string[]): Alignment {
  const statuses = new Map<number, WordStatus>();
  let i = 0;
  let j = from;
  const isLast = (k: number) => k >= heard.length - 1;
  while (i < heard.length && j < expected.length) {
    const h = heard[i];
    if (sameWord(expected[j], h)) {
      statuses.set(j++, 'ok');
      i++;
      continue;
    }
    // Recogniser merged two words into one ("يأيها" for "يا أيها").
    if (j + 1 < expected.length && sameWord(expected[j] + expected[j + 1], h)) {
      statuses.set(j++, 'ok');
      statuses.set(j++, 'ok');
      i++;
      continue;
    }
    // Recogniser split one word into two ("و الذين" for "والذين").
    if (i + 1 < heard.length && sameWord(expected[j], h + heard[i + 1])) {
      statuses.set(j++, 'ok');
      i += 2;
      continue;
    }
    // Reciter went back and repeated the last few words, as people do while
    // recalling. Two or more heard words in a row matching words just before
    // the current one (or one, if it is the word still being said) are a
    // repetition, not mistakes.
    const repeated = repetitionLength(expected, j, heard, i);
    if (repeated) {
      i += repeated;
      continue;
    }
    // Reciter skipped k words. A skip is only believed when the word after also
    // lines up, or the matched word is long enough not to be a coincidence.
    let skipped = 0;
    for (let k = 1; k <= SKIP_AHEAD && j + k < expected.length; k++) {
      if (!sameWord(expected[j + k], h)) continue;
      const confirmed = isLast(i)
        ? expected[j + k].length >= 4
        : j + k + 1 < expected.length && sameWord(expected[j + k + 1], heard[i + 1]);
      if (confirmed) {
        skipped = k;
        break;
      }
    }
    if (skipped) {
      for (let k = 0; k < skipped; k++) statuses.set(j + k, 'missed');
      statuses.set(j + skipped, 'ok');
      j += skipped + 1;
      i++;
      continue;
    }
    // Recogniser heard extra words (noise, a repeated word): drop them.
    let extra = 0;
    for (let l = 1; l <= EXTRA_AHEAD && i + l < heard.length; l++) {
      if (sameWord(expected[j], heard[i + l])) {
        extra = l;
        break;
      }
    }
    if (extra) {
      i += extra;
      continue;
    }
    // A different word was said in this word's place, judged once the reciter
    // has moved on to the next word.
    if (isLast(i)) break;
    statuses.set(j++, 'wrong');
    i++;
  }
  return { cursor: j, statuses };
}

// Said before starting a recitation but not part of the ayat themselves.
const OPENINGS = [tokenize('اعوذ بالله من الشيطان الرجيم'), tokenize('بسم الله الرحمن الرحيم')];

/** Drop a leading taʿawwudh and/or basmala from what was heard, including one still being said. */
export function stripOpenings(heard: string[]): string[] {
  let start = 0;
  for (const phrase of OPENINGS) {
    let k = 0;
    while (k < phrase.length && start + k < heard.length && sameWord(phrase[k], heard[start + k])) k++;
    if (k === phrase.length) start += k;
    else if (k > 0 && start + k === heard.length) return []; // the phrase is still being recited
  }
  return heard.slice(start);
}
