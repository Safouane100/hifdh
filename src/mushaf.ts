import { type Chapter, type Verse, type Word, getPageVerses, parseVerseKey, wordOrder } from './api';
import { type Script, pageFont } from './fonts';

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
/**
 * Colour class for each tajweed rule tag in quran.com's `text_uthmani_tajweed`,
 * grouped the way the Dar al-Maʿrifah colour-coded mushaf groups them.
 */
const RULE_COLOR: Record<string, string> = {
  ham_wasl: 'silent',
  laam_shamsiyah: 'silent',
  slnt: 'silent',
  idgham_wo_ghunnah: 'silent',
  idgham_mutajanisayn: 'silent',
  idgham_mutaqaribayn: 'silent',
  madda_normal: 'tabii',
  madda_permissible: 'jaiz',
  madda_obligatory_monfasel: 'jaiz',
  madda_obligatory_mottasel: 'wajib',
  madda_necessary: 'lazim',
  qalaqah: 'qalqalah',
  ghunnah: 'ghunnah',
  ikhafa: 'ghunnah',
  ikhafa_shafawi: 'ghunnah',
  iqlab: 'ghunnah',
  idgham_ghunnah: 'ghunnah',
  idgham_shafawi: 'ghunnah',
};

const toArabicDigits = (n: number) => n.toLocaleString('ar-EG', { useGrouping: false });

/**
 * Append tajweed-marked text as coloured spans. The markup comes from the API;
 * it is parsed inertly and only its text and known rule classes are copied, so
 * nothing from it is ever interpreted as HTML in the page.
 */
function appendTajweed(target: HTMLElement, markup: string): void {
  const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
  const copy = (from: Node, into: Node) => {
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        into.appendChild(document.createTextNode(child.textContent ?? ''));
      } else if (child instanceof Element) {
        // Unknown tags (e.g. the nested "custom-alef-maksora") inherit the
        // enclosing rule's colour.
        const color = RULE_COLOR[child.getAttribute('class') ?? ''];
        if (!color) {
          copy(child, into);
          continue;
        }
        const span = document.createElement('span');
        span.className = `tj-${color}`;
        into.appendChild(span);
        copy(child, span);
      }
    }
  };
  copy(doc.body, target);
}

function fillWord(el: HTMLElement, word: Word, verseNumber: number, script: Script): void {
  if (script === 'print') el.textContent = word.code_v1;
  // Uthmanic Hafs draws Arabic-Indic digits as the ayah-number ornament.
  else if (word.char_type_name === 'end') el.textContent = toArabicDigits(verseNumber);
  else appendTajweed(el, word.text_uthmani_tajweed);
}

export class MushafPage {
  readonly el: HTMLElement;
  readonly words = new Map<string, WordRef>();
  /** Basmala line per surah that begins on this page. */
  readonly basmala = new Map<number, { el: HTMLElement; box: Box }>();
  readonly firstWord: WordRef;
  readonly lastOrder: number;
  private fitted = false;

  constructor(
    readonly page: number,
    readonly script: Script,
    fonts: { page: string; basmala: string },
    verses: Verse[],
    /** Words of 1:1, reused to draw every basmala exactly as page 1 has it. */
    basmalaWords: Word[],
    chapters: Chapter[],
  ) {
    this.el = document.createElement('div');
    this.el.className = `mushaf-page script-${script}`;
    this.el.dataset.page = String(page);
    const linesEl = document.createElement('div');
    linesEl.className = page <= 2 ? 'page-lines opening' : 'page-lines';
    linesEl.style.fontFamily = `"${fonts.page}"`;

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
        lineEl.style.fontFamily = `"${fonts.basmala}"`;
        for (const word of basmalaWords) {
          if (word.char_type_name !== 'word') continue;
          const span = document.createElement('span');
          fillWord(span, word, 1, script);
          lineEl.append(span);
        }
        this.basmala.set(header.chapter, { el: lineEl, box: { l: 0, r: 0, cy: 0 } });
      }
      for (const { verse, word } of byLine.get(n) ?? []) {
        const [chapter, verseNumber] = parseVerseKey(verse.verse_key);
        const span = document.createElement('span');
        span.className = word.char_type_name === 'end' ? 'w end' : 'w';
        fillWord(span, word, verseNumber, script);
        if (script === 'print') span.title = word.text_uthmani;
        const ref: WordRef = {
          key: `${verse.verse_key}:${word.position}`,
          order: wordOrder(chapter, verseNumber, word.position),
          kind: word.char_type_name === 'end' ? 'end' : 'word',
          el: span,
          line: lineEl,
          box: { l: 0, r: 0, cy: 0 },
          uthmani: word.text_uthmani,
          plain: word.text_imlaei_simple ?? '',
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
    if (!this.fitted) this.fitLines(scale);
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

const building = new Map<string, Promise<MushafPage>>();

/** Fetch layout + fonts for a page and build its DOM (not yet attached). Cached per script. */
export function buildPage(page: number, script: Script, chapters: Chapter[]): Promise<MushafPage> {
  const key = `${script}:${page}`;
  let p = building.get(key);
  if (!p) {
    p = Promise.all([getPageVerses(page), getPageVerses(1), pageFont(page, script), pageFont(1, script)]).then(
      ([verses, openingPage, font, basmalaFont]) =>
        new MushafPage(
          page,
          script,
          { page: font, basmala: basmalaFont },
          verses,
          openingPage[0].words,
          chapters,
        ),
    );
    p.catch(() => building.delete(key));
    building.set(key, p);
  }
  return p;
}
