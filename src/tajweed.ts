// Tajweed colours, the way quran.com draws them: each word is a glyph from the
// King Fahd Complex's QCF V4 tajweed font for its page (1421 print), whose
// colours are built into the glyph as layers that each use a slot of the font's
// colour palette (CPAL). Themes pick one of the font's own palettes; a reader's
// own colours override slots with CSS `@font-palette-values override-colors`.
// See https://api-docs.quran.foundation/docs/tutorials/fonts/font-rendering/
// Pure data and string building, so it can be specified without a browser.

export type Theme = 'light' | 'sepia' | 'dark';

/** The font's built-in palette for each theme. */
export const BASE_PALETTE: Record<Theme, number> = { light: 0, dark: 1, sepia: 2 };

/** The 16 palette slots of every V4 page font, per theme (read from the fonts' CPAL table). */
const PALETTES: Record<Theme, string[]> = {
  light: ['#000000', '#a5a5a5', '#a3a5a5', '#b50000', '#ff7b00', '#ce9e00', '#09b000', '#3f48e6',
    '#2fadff', '#f40000', '#2ca4ab', '#ff0080', '#d8e9d8', '#000000', '#040000', '#9fa5a5'],
  dark: ['#ffffff', '#9d9999', '#999999', '#e30000', '#ff8e3b', '#ffc1e0', '#26b55d', '#3c84d5',
    '#00deff', '#ff5e8e', '#009b68', '#aa8a1c', '#2e544f', '#ffffff', '#fbffff', '#919999'],
  sepia: ['#000000', '#afabab', '#ababab', '#b7001c', '#e67b00', '#c09725', '#09b000', '#134fe1',
    '#00b4e0', '#ff0000', '#d52b5e', '#56a977', '#ffffff', '#6c0000', '#000009', '#a6abab'],
};

export type Rule = 'lazim' | 'wajib' | 'munfasil' | 'jaiz' | 'tabii' | 'ghunnah' | 'qalqalah' | 'tafkhim' | 'silent';

/** Palette slots each rule's letters are drawn with. */
const RULE_SLOTS: Record<Exclude<Rule, 'munfasil'>, number[]> = {
  silent: [1, 2, 15],
  lazim: [3],
  jaiz: [4],
  tabii: [5],
  ghunnah: [6],
  tafkhim: [7],
  qalqalah: [8],
  wajib: [9],
};

/**
 * The font draws madd munfaṣil and madd muttaṣil with the same slot (red).
 * Colour-coded mushafs often give munfaṣil its own colour, so a word with a
 * munfaṣil madd gets its own palette in which that slot is the munfaṣil colour.
 * (A munfaṣil sits at a word's end before a hamza in the next word, so it and a
 * muttaṣil practically never share a word.)
 */
const MUNFASIL_SLOT = 9;
const MUNFASIL_DEFAULT: Record<Theme, string> = { light: '#e8559b', dark: '#ff8cc6', sepia: '#d64b8c' };

/** The colour a rule is drawn in: the reader's own colour, else the theme's. */
export function ruleColour(theme: Theme, rule: Rule, custom: Partial<Record<Rule, string>> = {}): string {
  const own = custom[rule];
  if (own) return own;
  if (rule === 'munfasil') return MUNFASIL_DEFAULT[theme];
  return PALETTES[theme][RULE_SLOTS[rule][0]];
}

/** Whether a word's tajweed markup (`text_uthmani_tajweed`) contains a madd munfaṣil. */
export function hasMunfasil(markup: string): boolean {
  return markup.includes('class=madda_obligatory_monfasel');
}

// --- Spoken length, for timing ---------------------------------------------

const HELD_IDGHAM: Record<string, true> = { idgham_ghunnah: true, idgham_shafawi: true };
const UNSPOKEN: Record<string, true> = { slnt: true, ham_wasl: true, laam_shamsiyah: true };
/** Beats a rule adds beyond its letters: madd lengthening, ghunnah holds. */
const EXTRA_BEATS: Record<string, number> = {
  madda_permissible: 2,
  madda_obligatory_mottasel: 2,
  madda_obligatory_monfasel: 2,
  madda_necessary: 4,
  ghunnah: 1,
  ikhafa: 1,
  ikhafa_shafawi: 1,
  iqlab: 1,
};
// Letters, dagger alif and the small wāw/yāʾ of a lengthened pronoun.
const LETTER = /[\u0621-\u063A\u0641-\u064A\u0670\u0671\u06E5\u06E6]/u;
const SHADDA = '\u0651';

/**
 * Whether a word opens with the held, nasalised letter of an idghām with
 * ghunnah from the previous word, drawn green: the mīm of 83:4 أَنَّهُم مَّبْعُوثُونَ.
 */
export function opensWithHeldIdgham(markup: string): boolean {
  const m = /^<rule class=(\w+)>/.exec(markup);
  return m !== null && HELD_IDGHAM[m[1]] === true;
}

/**
 * Rough spoken length of a word in beats (ḥarakāt) from its tajweed markup,
 * read as recited in context: a final nūn or mīm merged into the next word is
 * silent, and an opening held letter takes three beats (doubled, plus its ghunnah).
 */
export function beats(markup: string): number {
  let n = 0;
  let skipShadda = false;
  for (const m of markup.matchAll(/<rule class=(\w+)>([^<]*)<\/rule>|([^<]+)/gu)) {
    const cls = m[1] ?? '';
    const text = m[2] ?? m[3];
    if (m.index === 0 && HELD_IDGHAM[cls] === true) {
      // Its shadda, when written, is already part of the three beats.
      n += 3;
      skipShadda = true;
      continue;
    }
    const merged = cls.startsWith('idgham') && m.index !== 0;
    for (const ch of text) {
      if (ch === SHADDA) {
        if (!skipShadda) n += 1;
        skipShadda = false;
      } else if (LETTER.test(ch)) {
        skipShadda = false;
        if (UNSPOKEN[cls] !== true && !(merged && (ch === 'ن' || ch === 'م'))) n += 1;
      }
    }
    n += EXTRA_BEATS[cls] ?? 0;
  }
  return n;
}

export const pageFontFamily = (page: number) => `p${page}-v4`;

/** `font-palette` value for a word on V4 page `page`. */
export const paletteName = (page: number, munfasil: boolean) => `--tj${munfasil ? '-munfasil' : ''}-p${page}`;

/** The `@font-palette-values` rules for one V4 page font: its words, and its words with a munfaṣil. */
export function paletteCss(page: number, theme: Theme, custom: Partial<Record<Rule, string>> = {}): string {
  const overrides: [number, string][] = [];
  for (const [rule, slots] of Object.entries(RULE_SLOTS) as [Rule, number[]][]) {
    const own = custom[rule];
    if (own) for (const slot of slots) overrides.push([slot, own]);
  }
  const rule = (name: string, extra: [number, string][]) => {
    const all = [...overrides.filter(([slot]) => !extra.some(([s]) => s === slot)), ...extra];
    const override = all.length ? `override-colors:${all.map(([s, c]) => `${s} ${c}`).join(',')};` : '';
    return `@font-palette-values ${name}{font-family:"${pageFontFamily(page)}";base-palette:${BASE_PALETTE[theme]};${override}}`;
  };
  return (
    rule(paletteName(page, false), []) +
    '\n' +
    rule(paletteName(page, true), [[MUNFASIL_SLOT, ruleColour(theme, 'munfasil', custom)]]) +
    '\n'
  );
}
