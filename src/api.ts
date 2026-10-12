// Data sources are the same public endpoints quran.com's own web app uses:
// page layout (King Fahd Madani mushaf, 604 pages, 15 lines) from api.quran.com,
// word-level recitation timings from api.qurancdn.com.
const API = 'https://api.quran.com/api/v4';
const QDC = 'https://api.qurancdn.com/api/qdc';

export const PAGE_COUNT = 604;

export interface Chapter {
  id: number;
  name_simple: string;
  name_arabic: string;
  translated_name: { name: string };
  pages: [number, number];
  verses_count: number;
  bismillah_pre: boolean;
}

export interface Word {
  position: number;
  /** 'word' for spoken words, 'end' for the ayah-number ornament. */
  char_type_name: string;
  /** Glyph code for the page-specific QPC V1 (1405 print) font. */
  code_v1: string;
  line_number: number;
  page_number: number;
  text_uthmani: string;
  /** `text_uthmani` with `<rule class=…>` tags around letters a tajweed rule applies to. */
  text_uthmani_tajweed: string;
  /** Plain modern spelling without diacritics (e.g. "اانذرتهم"), for matching speech. */
  text_imlaei_simple: string;
}

export interface Verse {
  verse_key: string;
  verse_number: number;
  juz_number: number;
  words: Word[];
}

/** [wordPosition, startMs, endMs] */
export type Segment = [number, number, number];

export interface VerseTiming {
  verse_key: string;
  timestamp_from: number;
  timestamp_to: number;
  segments: Segment[];
}

export interface ChapterAudio {
  chapter: number;
  url: string;
  timings: VerseTiming[];
}

export interface Reciter {
  id: number;
  name: string;
  style: string;
}

const memo = new Map<string, Promise<unknown>>();

function getJson<T>(url: string): Promise<T> {
  let p = memo.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
      return res.json() as Promise<T>;
    });
    // Failed requests must be retryable, so never keep a rejected promise.
    p.catch(() => memo.delete(url));
    memo.set(url, p);
  }
  return p;
}

export async function getChapters(): Promise<Chapter[]> {
  const data = await getJson<{ chapters: Chapter[] }>(`${API}/chapters?language=en`);
  return data.chapters;
}

// Mushaf 2 is quran.com's "KFGQPC V1" layout: the 1405 AH King Fahd Madani
// print. Its page and line breaks differ from the 1421 print (quran.com's V2/V4
// and tajweed view), e.g. page 595 there opens with the end of Al-Balad instead
// of Ash-Shams.
const MADANI_1405_MUSHAF = 2;

export async function getPageVerses(page: number): Promise<Verse[]> {
  const data = await getJson<{ verses: Verse[] }>(
    `${QDC}/verses/by_page/${page}?words=true&per_page=all&filter_page_words=true` +
      `&word_fields=verse_key,page_number,line_number,text_uthmani,text_uthmani_tajweed,text_imlaei_simple,code_v1` +
      `&mushaf=${MADANI_1405_MUSHAF}`,
  );
  return data.verses;
}

/** A word's glyph in quran.com's QCF V4 tajweed fonts (1421 print, mushaf 19). */
export interface V4Glyph {
  code: string;
  /** 1421-print page, which selects the font the code belongs to. */
  page: number;
}

const TAJWEED_V4_MUSHAF = 19;

/** Words of the 1421 print as the API returns them for mushaf 19. */
export interface V4Verse {
  verse_key: string;
  words: { position: number; code_v2: string; page_number: number; char_type_name: string }[];
}

/**
 * Index 1421-print words by `${chapter}:${verse}:${position}`. Ayah-number
 * markers are left out: they are drawn in Uthmanic Hafs, as the Quran
 * Foundation's rendering guide advises.
 */
export function indexV4Glyphs(verses: V4Verse[]): Map<string, V4Glyph> {
  const glyphs = new Map<string, V4Glyph>();
  for (const verse of verses) {
    for (const word of verse.words) {
      if (word.char_type_name !== 'word') continue;
      glyphs.set(`${verse.verse_key}:${word.position}`, { code: word.code_v2, page: word.page_number });
    }
  }
  return glyphs;
}

async function getV4PageGlyphs(page: number): Promise<Map<string, V4Glyph>> {
  const data = await getJson<{ verses: V4Verse[] }>(
    `${QDC}/verses/by_page/${page}?words=true&per_page=all&filter_page_words=true` +
      `&word_fields=verse_key,page_number,code_v2&mushaf=${TAJWEED_V4_MUSHAF}`,
  );
  return indexV4Glyphs(data.verses);
}

/**
 * V4 glyphs for the words of 1405-print page `page`. The two prints break
 * pages differently, but never by more than a page, so the 1421 pages
 * `page - 1` to `page + 1` hold all its words.
 */
export async function getV4Glyphs(page: number): Promise<Map<string, V4Glyph>> {
  const pages = [page - 1, page, page + 1].filter((p) => p >= 1 && p <= PAGE_COUNT);
  const maps = await Promise.all(pages.map(getV4PageGlyphs));
  return new Map(maps.flatMap((m) => [...m]));
}

// "Kids repeat" style recitations repeat every word, so their segment data
// cannot be mapped onto a single pass over the page.
const UNSUPPORTED_STYLES = /repeat/i;

export async function getReciters(): Promise<Reciter[]> {
  const data = await getJson<{
    reciters: { id: number; name: string; style?: { name?: string } }[];
  }>(`${QDC}/audio/reciters?locale=en`);
  return data.reciters
    .map((r) => ({ id: r.id, name: r.name, style: r.style?.name ?? '' }))
    .filter((r) => !UNSUPPORTED_STYLES.test(r.style));
}

export async function getChapterAudio(reciter: number, chapter: number): Promise<ChapterAudio> {
  const data = await getJson<{
    audio_files: { audio_url: string; verse_timings: VerseTiming[] }[];
  }>(`${QDC}/audio/reciters/${reciter}/audio_files?chapter=${chapter}&segments=true`);
  const file = data.audio_files[0];
  if (!file) throw new Error(`No audio for reciter ${reciter}, surah ${chapter}`);
  return { chapter, url: file.audio_url, timings: file.verse_timings };
}

export function parseVerseKey(key: string): [chapter: number, verse: number] {
  const [c, v] = key.split(':');
  return [Number(c), Number(v)];
}

/** Total order over every word of the Quran: surah, then ayah, then word position. */
export function wordOrder(chapter: number, verse: number, position: number): number {
  return chapter * 1_000_000 + verse * 1_000 + position;
}
