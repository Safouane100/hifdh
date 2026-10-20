import { type Chapter, type V4Glyph, type Verse, type Word, getPageVerses, getV4Glyphs, parseVerseKey, wordOrder } from './api';
import { type Script, printFont, tajweedFont, textFont, v4Build } from './fonts';
import { beats, hasMunfasil, opensWithHeldIdgham, paletteName } from './tajweed';

/** Horizontal extent and vertical centre of a word, in unscaled page pixels. */
export interface Box {
  l: number;
  r: number;
  cy: number;
}

export interface WordRef {
  /** `${chapter}:${verse}:${position}` */
  key: string;
  order: number;
  kind: 'word' | 'end';
  el: HTMLElement;
  line: HTMLElement;
  box: Box;
  /** Uthmani spelling, for showing the word in messages. */
  uthmani: string;
  /** Plain spelling, for matching what a speech recogniser hears. */
  plain: string;
  /** English word-by-word translation and transliteration, for the hover popover. */
  translation: string;
  transliteration: string;
  /** Spoken length and held opening letter, from the tajweed markup (see timeline.ts `retimeHeldStarts`). */
  beats: number;
  heldStart: boolean;
}

const LINES_PER_PAGE = 15;

// Every line of the printed page is justified to the same width except these,
// which the 1405 print centres (surah endings at the end of Juz ʿAmma). Pages
// 1–2 are set entirely centred. Found by measuring every line of the V1 page
// fonts: these are the only lines under 85% of their page's widest line.
const CENTERED_LINES: Record<number, number[]> = {
  602: [5, 15],
  603: [10],
  604: [9, 14, 15],
};

const toArabicDigits = (n: number) => n.toLocaleString('ar-EG', { useGrouping: false });

/** How a page's words are drawn: resolved fonts and, for tajweed, each word's V4 glyph. */
interface Drawing {
  script: Script;
  /** Font of the text block: the page's glyphs (print), or Uthmanic Hafs for verse numbers (tajweed). */
  lineFont: string;
  /** Print: page 1's glyph font, for the basmala. */
  basmalaFont?: string;
  /** Tajweed: V4 glyph of every word on the page (and of 1:1, for the basmala). */
  glyphs?: Map<string, V4Glyph>;
  /** Tajweed: font family of each 1421-print page the glyphs come from. */
  families?: Map<number, string>;
}

function fillWord(el: HTMLElement, word: Word, key: string, verseNumber: number, drawing: Drawing): void {
  if (drawing.script === 'print') {
    el.textContent = word.code_v1;
    return;
  }
  // Uthmanic Hafs draws Arabic-Indic digits as the ayah-number ornament.
  if (word.char_type_name === 'end') {
    el.textContent = toArabicDigits(verseNumber);
    return;
  }
  const glyph = drawing.glyphs?.get(key);
  const family = glyph && drawing.families?.get(glyph.page);
  if (!glyph || !family) {
    // Not expected (every word has a V4 glyph), but a missing one shows as plain text.
    el.textContent = word.text_uthmani;
    return;
  }
  el.classList.add('v4');
  el.textContent = glyph.code;
  el.style.fontFamily = `"${family}"`;
  el.style.fontPalette = paletteName(glyph.page, hasMunfasil(word.text_uthmani_tajweed));
}

export class MushafPage {
  readonly el: HTMLElement;
  readonly words = new Map<string, WordRef>();
  /** Basmala line per surah that begins on this page. */
  readonly basmala = new Map<number, { el: HTMLElement; box: Box }>();
  /**
   * Ghost line ends: a faded copy of the next line's first word, just past the
   * end of the line, as a preview while reading it (the "preview the next
   * line" setting).
   */
  readonly ghostOnLine = new Map<HTMLElement, HTMLElement>();
  readonly firstWord: WordRef;
  readonly lastOrder: number;
  private fitted = false;
  readonly script: Script;

  constructor(
    readonly page: number,
    /** Font build the page was drawn with (see fonts.ts `v4Build`); another build needs a rebuild. */
    readonly build: string,
    drawing: Drawing,
    verses: Verse[],
    /** Words of 1:1, reused to draw every basmala exactly as page 1 has it. */
    basmalaWords: Word[],
    chapters: Chapter[],
  ) {
    this.script = drawing.script;
    this.el = document.createElement('div');
    this.el.className = `mushaf-page script-${drawing.script}`;
    this.el.dataset.page = String(page);
    const linesEl = document.createElement('div');
    linesEl.className = page <= 2 ? 'page-lines opening' : 'page-lines';
    linesEl.style.fontFamily = `"${drawing.lineFont}"`;

    type Placed = { verse: Verse; word: Word };
    const byLine = new Map<number, Placed[]>();
    const surahStartLine = new Map<number, number>();
    let lastChapter = 0;
    for (const verse of verses) {
      const [chapter] = parseVerseKey(verse.verse_key);
      lastChapter = chapter;
      for (const word of verse.words) {
        if (word.page_number !== page) continue;
        let line = byLine.get(word.line_number);
        if (!line) byLine.set(word.line_number, (line = []));
        line.push({ verse, word });
        if (verse.verse_number === 1) {
          surahStartLine.set(chapter, Math.min(surahStartLine.get(chapter) ?? Infinity, word.line_number));
        }
      }
    }

    // Surah title and basmala lines are not part of the word data; they fill the
    // gap lines directly above the first ayah of a surah (Al-Fatiha's basmala is
    // its first ayah and At-Tawbah has none, so those get only a title). When a
    // surah starts on line 1 or 2, its title (and basmala) sit at the foot of
    // the previous page, and lines that fall outside 1–15 are simply not drawn.
    const headerAt = new Map<number, { chapter: number; kind: 'title' | 'basmala' }>();
    const placeHeader = (chapter: number, firstLine: number) => {
      const hasBasmala = chapter !== 1 && chapter !== 9;
      if (hasBasmala) headerAt.set(firstLine - 1, { chapter, kind: 'basmala' });
      headerAt.set(firstLine - (hasBasmala ? 2 : 1), { chapter, kind: 'title' });
    };
    for (const [chapter, line] of surahStartLine) placeHeader(chapter, line);
    const maxUsed = Math.max(...byLine.keys());
    if (page > 2 && maxUsed < LINES_PER_PAGE && lastChapter < 114) {
      const next = lastChapter + 1;
      placeHeader(next, maxUsed + (next === 9 ? 2 : 3));
    }
    // Pages 1–2 hold a short block that the print centres vertically.
    const firstLine = page <= 2 ? Math.min(...byLine.keys(), ...headerAt.keys()) : 1;
    const centered = CENTERED_LINES[page] ?? [];

    let first: WordRef | undefined;
    let lastOrder = 0;
    for (let n = firstLine; n <= LINES_PER_PAGE; n++) {
      const lineEl = document.createElement('div');
      lineEl.className = page <= 2 || centered.includes(n) ? 'line centered' : 'line';
      const header = headerAt.get(n);
      if (header?.kind === 'title') {
        lineEl.classList.add('surah-title');
        const frame = document.createElement('div');
        frame.className = 'surah-frame';
        frame.textContent = `سُورَةُ ${chapters[header.chapter - 1].name_arabic}`;
        lineEl.append(frame);
      } else if (header?.kind === 'basmala') {
        lineEl.classList.add('basmala', 'centered');
        if (drawing.basmalaFont) lineEl.style.fontFamily = `"${drawing.basmalaFont}"`;
        for (const word of basmalaWords) {
          if (word.char_type_name !== 'word') continue;
          const span = document.createElement('span');
          fillWord(span, word, `1:1:${word.position}`, 1, drawing);
          lineEl.append(span);
        }
        this.basmala.set(header.chapter, { el: lineEl, box: { l: 0, r: 0, cy: 0 } });
      }
      for (const { verse, word } of byLine.get(n) ?? []) {
        const [chapter, verseNumber] = parseVerseKey(verse.verse_key);
        const span = document.createElement('span');
        span.className = word.char_type_name === 'end' ? 'w end' : 'w';
        fillWord(span, word, `${verse.verse_key}:${word.position}`, verseNumber, drawing);
        const ref: WordRef = {
          key: `${verse.verse_key}:${word.position}`,
          order: wordOrder(chapter, verseNumber, word.position),
          kind: word.char_type_name === 'end' ? 'end' : 'word',
          el: span,
          line: lineEl,
          box: { l: 0, r: 0, cy: 0 },
          uthmani: word.text_uthmani,
          plain: word.text_imlaei_simple ?? '',
          translation: word.translation?.text ?? '',
          transliteration: word.transliteration?.text ?? '',
          beats: beats(word.text_uthmani_tajweed),
          heldStart: opensWithHeldIdgham(word.text_uthmani_tajweed),
        };
        span.dataset.k = ref.key;
        this.words.set(ref.key, ref);
        if (ref.kind === 'word' && (!first || ref.order < first.order)) first = ref;
        lastOrder = Math.max(lastOrder, ref.order);
        lineEl.append(span);
      }
      linesEl.append(lineEl);
    }
    if (!first) throw new Error(`Page ${page} has no words`);
    this.firstWord = first;
    this.lastOrder = lastOrder;

    // Running head and page number, as printed above and below the text block.
    const [firstChapter] = parseVerseKey(first.key);
    const head = document.createElement('div');
    head.className = 'page-head';
    const surahName = document.createElement('span');
    surahName.textContent = `سُورَةُ ${chapters[firstChapter - 1].name_arabic}`;
    const juz = document.createElement('span');
    juz.textContent = `الجُزْءُ ${toArabicDigits(verses[0].juz_number)}`;
    head.append(surahName, juz);
    const foot = document.createElement('div');
    foot.className = 'page-foot';
    foot.textContent = toArabicDigits(page);
    this.el.append(head, linesEl, foot);
  }

  /** Record word geometry. The page must be attached to the document (it may be hidden). */
  measure(): void {
    const scale = this.el.getBoundingClientRect().width / this.el.offsetWidth || 1;
    if (!this.fitted) {
      this.fitLines(scale);
      this.addGhosts();
    }
    const origin = this.el.getBoundingClientRect();
    const toBox = (r: DOMRect, line: HTMLElement): Box => {
      const lr = line.getBoundingClientRect();
      return {
        l: (r.left - origin.left) / scale,
        r: (r.right - origin.left) / scale,
        cy: ((lr.top + lr.bottom) / 2 - origin.top) / scale,
      };
    };
    for (const ref of this.words.values()) ref.box = toBox(ref.el.getBoundingClientRect(), ref.line);
    for (const b of this.basmala.values()) {
      // Measure the glyph run rather than the full-width line box.
      const range = document.createRange();
      range.selectNodeContents(b.el);
      b.box = toBox(range.getBoundingClientRect(), b.el);
    }
  }

  /**
   * Copy each line's first word past the end of the line before it (after
   * fitLines, so sizes match). Not before a new ayah: the reciter pauses on the
   * ayah number there, so there is time to find the next line anyway.
   */
  private addGhosts(): void {
    const lines = [...this.el.querySelectorAll<HTMLElement>('.line')];
    for (let i = 0; i + 1 < lines.length; i++) {
      const words = lines[i].querySelectorAll<HTMLElement>(':scope > .w');
      const first = lines[i + 1].querySelector<HTMLElement>(':scope > .w:not(.end)');
      if (words.length === 0 || !first?.dataset.k || first.dataset.k.endsWith(':1')) continue;
      const copy = first.cloneNode(true) as HTMLElement;
      copy.className = first.classList.contains('v4') ? 'v4' : '';
      copy.removeAttribute('data-k');
      const ghost = document.createElement('span');
      ghost.className = 'ghost';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.append(copy);
      // The last word in the DOM is the leftmost (the line's end, in RTL).
      ghost.style.right = `${lines[i].clientWidth - words[words.length - 1].offsetLeft}px`;
      lines[i].append(ghost);
      this.ghostOnLine.set(lines[i], ghost);
    }
  }

  /**
   * Unicode text is not compressed on dense lines the way the calligrapher did,
   * so in tajweed mode some lines come out wider than the text block. Shrink the
   * words of just those lines until they fit; the rest are spread to full width.
   */
  private fitLines(scale: number): void {
    this.fitted = true;
    if (this.script !== 'tajweed') return;
    for (const line of this.el.querySelectorAll<HTMLElement>('.line')) {
      const spans = [...line.children] as HTMLElement[];
      const natural = spans.reduce((sum, s) => sum + s.getBoundingClientRect().width, 0) / scale;
      const available = line.clientWidth;
      if (natural <= available) continue;
      const k = available / natural;
      for (const s of spans) s.style.fontSize = `${parseFloat(getComputedStyle(s).fontSize) * k}px`;
    }
  }
}

/** Load what drawing a page's `verses` in `script` needs: fonts and, for tajweed, the words' V4 glyphs. */
async function loadDrawing(script: Script, page: number, verses: Verse[], opening: Verse): Promise<Drawing> {
  if (script === 'print') {
    const [lineFont, basmalaFont] = await Promise.all([printFont(page), printFont(1)]);
    return { script, lineFont, basmalaFont };
  }
  const [lineFont, glyphs, openingGlyphs] = await Promise.all([textFont(), getV4Glyphs(page), getV4Glyphs(1)]);
  const needed = new Map<string, V4Glyph>();
  for (const verse of [...verses, opening]) {
    for (const word of verse.words) {
      const key = `${verse.verse_key}:${word.position}`;
      const glyph = glyphs.get(key) ?? openingGlyphs.get(key);
      if (glyph && word.char_type_name === 'word') needed.set(key, glyph);
    }
  }
  const pages = [...new Set([...needed.values()].map((g) => g.page))];
  const families = new Map(await Promise.all(pages.map(async (p) => [p, await tajweedFont(p)] as const)));
  return { script, lineFont, glyphs: needed, families };
}

const building = new Map<string, Promise<MushafPage>>();

/** Fetch layout + fonts for a page and build its DOM (not yet attached). Cached per script and font build. */
export function buildPage(page: number, script: Script, chapters: Chapter[]): Promise<MushafPage> {
  const build = script === 'tajweed' ? v4Build() : 'v1';
  const key = `${script}:${build}:${page}`;
  let p = building.get(key);
  if (!p) {
    p = Promise.all([getPageVerses(page), getPageVerses(1)]).then(async ([verses, openingPage]) => {
      const drawing = await loadDrawing(script, page, verses, openingPage[0]);
      return new MushafPage(page, build, drawing, verses, openingPage[0].words, chapters);
    });
    p.catch(() => building.delete(key));
    building.set(key, p);
  }
  return p;
}
