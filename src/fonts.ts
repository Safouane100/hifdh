// Pages follow the 1405 AH King Fahd Madani print (quran.com's "KFGQPC V1"
// layout). It can be drawn two ways:
// - 'print': every page has its own V1 font whose glyphs are that page's exact
//   calligraphy, one glyph per word. These fonts carry no colour.
// - 'tajweed': the same words, line breaks and pages, set in the King Fahd
//   Complex "Uthmanic Hafs" font from Unicode text, so individual letters can be
//   coloured by tajweed rule.
const FONT_BASE = 'https://verses.quran.foundation/fonts/quran/hafs';
const TEXT_FONT_FAMILY = 'uthmanic-hafs';

export type Script = 'print' | 'tajweed';
export type Theme = 'light' | 'sepia' | 'dark';

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

/** CSS font-family for words on `page`; loads it on first use. */
export async function pageFont(page: number, script: Script): Promise<string> {
  if (script === 'tajweed') {
    await loadFont(TEXT_FONT_FAMILY, `${FONT_BASE}/uthmanic_hafs/UthmanicHafs1Ver18.woff2`);
    return TEXT_FONT_FAMILY;
  }
  const family = `qpc-v1-p${page}`;
  await loadFont(family, `${FONT_BASE}/v1/woff2/p${page}.woff2`);
  return family;
}
