// Tajweed colouring specs. Words are drawn, as on quran.com, with their glyph
// from the King Fahd Complex QCF V4 tajweed font, whose colours are built in;
// the app chooses the glyph, the palette and the reader's own colours. Each
// case below is a colouring problem that was reported, using the exact data
// quran.com's API returns for those words.
import { describe, expect, it } from 'vitest';
import { type V4Verse, indexV4Glyphs } from './api';
import { hasMunfasil, paletteCss, paletteName, ruleColour } from './tajweed';

// quran.com's 1421-print (mushaf 19) data for the reported ayat.
const V4_DATA: V4Verse[] = [
  { verse_key: '96:16', words: [
    { position: 1, code_v2: 'ﱓ', page_number: 598, char_type_name: 'word' },
    { position: 2, code_v2: 'ﱔ', page_number: 598, char_type_name: 'word' },
    { position: 3, code_v2: 'ﱕ', page_number: 598, char_type_name: 'word' },
    { position: 4, code_v2: 'ﱖ', page_number: 598, char_type_name: 'end' },
  ] },
  { verse_key: '90:2', words: [
    { position: 1, code_v2: 'ﱲ', page_number: 594, char_type_name: 'word' },
    { position: 2, code_v2: 'ﱳ', page_number: 594, char_type_name: 'word' },
    { position: 3, code_v2: 'ﱴ', page_number: 594, char_type_name: 'word' },
  ] },
  { verse_key: '90:14', words: [
    { position: 2, code_v2: 'ﲫ', page_number: 594, char_type_name: 'word' },
    { position: 4, code_v2: 'ﲭ', page_number: 594, char_type_name: 'word' },
  ] },
  { verse_key: '94:3', words: [{ position: 1, code_v2: 'ﱁ', page_number: 597, char_type_name: 'word' }] },
];

const hueOf = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max !== r) throw new Error(`${hex} is not a red-dominant colour`);
  return (((g - b) / (max - min)) * 60 + 360) % 360;
};

describe('reported words are drawn with quran.com’s own tajweed glyph, so only the right marks are coloured', () => {
  const glyphs = indexV4Glyphs(V4_DATA);

  it('96:16 نَاصِيَةٍ كَـٰذِبَةٍ (“why is the k green”): both words use their V4 glyphs from 1421 page 598', () => {
    expect(glyphs.get('96:16:1')).toEqual({ code: 'ﱓ', page: 598 });
    expect(glyphs.get('96:16:2')).toEqual({ code: 'ﱔ', page: 598 });
  });

  it('90:2 حِلٌّۢ (“only the meem should be green, not the entire letter”): uses its V4 glyph from page 594', () => {
    expect(glyphs.get('90:2:2')).toEqual({ code: 'ﱳ', page: 594 });
  });

  it('90:14 إِطْعَـٰمٌ … يَوْمٍ (“the tanween colour is misplaced”): use their V4 glyphs from page 594', () => {
    expect(glyphs.get('90:14:2')).toEqual({ code: 'ﲫ', page: 594 });
    expect(glyphs.get('90:14:4')).toEqual({ code: 'ﲭ', page: 594 });
  });

  it('leaves ayah numbers out, to be drawn in Uthmanic Hafs', () => {
    expect(glyphs.has('96:16:4')).toBe(false);
  });

  it('a word is drawn with the palette of the font its glyph belongs to', () => {
    expect(paletteName(598, false)).toBe('--tj-p598');
  });
});

describe('madd munfaṣil is pink (94:3 ٱلَّذِىٓ: “the i is orange but pink in my mushaf”)', () => {
  const alladhi = 'ٱلَّذ<rule class=madda_obligatory_monfasel>ِىٓ</rule>';
  const samaa = '<rule class=ham_wasl>ٱ</rule><rule class=laam_shamsiyah>ل</rule>سَّم<rule class=madda_obligatory_mottasel>َا</rule>ٓءِ';

  it('recognises ٱلَّذِىٓ as a munfaṣil word, but not ٱلسَّمَآءِ (muttaṣil, 2:19)', () => {
    expect(hasMunfasil(alladhi)).toBe(true);
    expect(hasMunfasil(samaa)).toBe(false);
  });

  it('gives munfaṣil words their own palette name', () => {
    expect(paletteName(597, true)).not.toBe(paletteName(597, false));
  });

  it('recolours slot 9 (the font’s red for both madds) only in the munfaṣil palette, pink by default', () => {
    const css = paletteCss(597, 'light');
    const [plain, munfasil] = css.trim().split('\n');
    expect(plain).toContain(paletteName(597, false));
    expect(plain).not.toContain('override-colors');
    expect(munfasil).toContain(paletteName(597, true));
    const pink = /override-colors:9 (#[0-9a-f]{6})/.exec(munfasil)?.[1];
    expect(pink).toBe(ruleColour('light', 'munfasil'));
    expect(hueOf(pink!)).toBeGreaterThan(300);
    expect(hueOf(pink!)).toBeLessThan(350);
  });

  it('keeps muttaṣil the font’s red', () => {
    expect(ruleColour('light', 'wajib')).toBe('#f40000');
  });

  it('is pink in every theme', () => {
    for (const theme of ['light', 'sepia', 'dark'] as const) {
      const hue = hueOf(ruleColour(theme, 'munfasil'));
      expect(hue, theme).toBeGreaterThan(300);
      expect(hue, theme).toBeLessThan(350);
    }
  });
});

describe('themes and the reader’s own colours', () => {
  it('uses the font’s built-in palette for each theme', () => {
    expect(paletteCss(1, 'light')).toContain('base-palette:0');
    expect(paletteCss(1, 'dark')).toContain('base-palette:1');
    expect(paletteCss(1, 'sepia')).toContain('base-palette:2');
  });

  it('applies an own colour to every slot of its rule, in both palettes', () => {
    const [plain, munfasil] = paletteCss(10, 'light', { ghunnah: '#123456', silent: '#abcdef' }).trim().split('\n');
    for (const rule of [plain, munfasil]) {
      expect(rule).toContain('6 #123456');
      for (const slot of [1, 2, 15]) expect(rule).toContain(`${slot} #abcdef`);
    }
  });

  it('lets an own munfaṣil colour replace the pink without touching muttaṣil', () => {
    const [plain, munfasil] = paletteCss(10, 'light', { munfasil: '#00aa88' }).trim().split('\n');
    expect(munfasil).toContain('9 #00aa88');
    expect(plain).not.toContain('9 #00aa88');
  });

  it('keeps munfaṣil pink when muttaṣil is given an own colour', () => {
    const [plain, munfasil] = paletteCss(10, 'light', { wajib: '#111111' }).trim().split('\n');
    expect(plain).toContain('9 #111111');
    expect(munfasil).toContain(`9 ${ruleColour('light', 'munfasil')}`);
    expect(munfasil).not.toContain('9 #111111');
  });
});
