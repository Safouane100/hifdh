// Pages follow the 1405 AH King Fahd Madani print (quran.com's "KFGQPC V1"
// layout). Words are drawn two ways:
// - 'print': every page has its own QCF V1 font whose glyphs are that page's
//   exact calligraphy, one glyph per word. These fonts carry no colour.
// - 'tajweed': each word is its glyph from the QCF V4 tajweed font of the page
//   it sits on in the 1421 print, exactly as quran.com draws it, with the
//   tajweed colours built into the glyph (see tajweed.ts). Verse numbers use
//   the Uthmanic Hafs font, as the Quran Foundation's rendering guide advises.
import { type Rule, type Theme, pageFontFamily, paletteCss } from './tajweed';

const FONT_BASE = 'https://verses.quran.foundation/fonts/quran/hafs';
export const TEXT_FONT_FAMILY = 'uthmanic-hafs';

export type Script = 'print' | 'tajweed';
export type { Theme };

const loaded = new Map<string, Promise<void>>();

function loadFont(family: string, url: string): Promise<void> {
  let p = loaded.get(family);
  if (!p) {
    const face = new FontFace(family, `url(${url}) format('woff2')`, { display: 'block' });
    p = face.load().then((f) => {
      document.fonts.add(f);
    });
    p.catch(() => loaded.delete(family));
    loaded.set(family, p);
  }
  return p;
}

/** CSS font-family of the 1405 print's own glyphs for `page`; loads it on first use. */
export async function printFont(page: number): Promise<string> {
  const family = `qpc-v1-p${page}`;
  await loadFont(family, `${FONT_BASE}/v1/woff2/p${page}.woff2`);
  return family;
}

/** Unicode Uthmanic Hafs, for verse numbers and any word without a V4 glyph. */
export async function textFont(): Promise<string> {
  await loadFont(TEXT_FONT_FAMILY, `${FONT_BASE}/uthmanic_hafs/UthmanicHafs1Ver18.woff2`);
  return TEXT_FONT_FAMILY;
}

// Firefox ignores the palette of these colour fonts in dark mode, so there, as on
// quran.com, the V4 fonts come in their dark-coloured OT-SVG build instead (with
// fixed colours: your own colours don't apply).
const FIREFOX = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');
let theme: Theme = 'light';
let custom: Partial<Record<Rule, string>> = {};

/** Which V4 font build is in use; pages built for another build must be rebuilt. */
export function v4Build(): 'colrv1' | 'ot-svg-dark' {
  return FIREFOX && theme === 'dark' ? 'ot-svg-dark' : 'colrv1';
}

/** CSS font-family of V4 tajweed page `page` in the current build; loads it on first use. */
export async function tajweedFont(page: number): Promise<string> {
  const build = v4Build();
  const family = build === 'colrv1' ? pageFontFamily(page) : `${pageFontFamily(page)}-dark`;
  const url = build === 'colrv1' ? `${FONT_BASE}/v4/colrv1/woff2/p${page}.woff2` : `${FONT_BASE}/v4/ot-svg/dark/woff2/p${page}.woff2`;
  await loadFont(family, url);
  palettePages.add(page);
  renderPalettes();
  return family;
}

const palettePages = new Set<number>();
const paletteStyle = document.createElement('style');
document.head.append(paletteStyle);

function renderPalettes(): void {
  let css = '';
  for (const page of palettePages) css += paletteCss(page, theme, custom);
  paletteStyle.textContent = css;
}

/** Point every loaded V4 font at the theme's palette, with the reader's own colours. */
export function setTajweedColours(nextTheme: Theme, nextCustom: Partial<Record<Rule, string>>): void {
  theme = nextTheme;
  custom = nextCustom;
  renderPalettes();
}
