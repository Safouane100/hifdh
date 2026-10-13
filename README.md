# Hifz Focus

A Quran memorization site built around a fixed gaze. You look at one dot in the middle of the screen and keep your eyes still; the whole mushaf page moves underneath it in sync with the recitation, so the word (and, in glide mode, roughly the letter) being pronounced is always right at the dot. Over repeated passes you see the page's exact layout while hearing correct recitation.

## What it uses

- **Layout:** the 15-line King Fahd Madani mushaf, 1405 AH print (Hafs ʿan ʿĀṣim, 604 pages), from quran.com's `qdc` API with its "KFGQPC V1" layout (`mushaf=2`). This is the print where page 595 holds Ash-Shams and the first 5 lines of Al-Layl. The 1421 print (quran.com's V2/V4 and its tajweed view) breaks pages differently. Pages are shown one at a time as printed: running head, 15 lines justified to one width (only the lines the print centres at the end of Juz ʿAmma are centred), and the page number. The page turns when the recitation reaches the next page's first word.
- **Script**, switched with *Tajweed colours* in Settings:
  - on (default): the same pages and lines drawn exactly the way quran.com draws its tajweed view: each word is its glyph from the King Fahd Complex **QCF V4** tajweed font of its page in the 1421 print (`code_v2`, mushaf 19), with the tajweed colours built into the glyph, themed with the font's own palettes, as the [Quran Foundation font-rendering guide](https://api-docs.quran.foundation/docs/tutorials/fonts/font-rendering/) describes. So the lettering is quran.com's (1421-print calligraphy) laid on your 1405 lines; every 1405 word is within one page of its place in the 1421 print, which the app relies on to find it. Verse numbers are drawn in Uthmanic Hafs, as the guide advises.
  - off: the 1405 print's own per-page V1 glyph fonts, i.e. the exact printed calligraphy, which has no colours.
- **Audio and sync:** per-surah recitations with word-level timestamps from `api.qurancdn.com` (the data behind quran.com's word highlighting). "Kids repeat" recitations are excluded because their timings repeat every word.

Everything is fetched at runtime from those public endpoints, so the site needs an internet connection and has no backend.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/, host anywhere
npm test           # tajweed colouring and focus timing specs
```

It's published at https://safouane100.github.io/hifdh/: every push to `main` runs the tests, builds, and deploys `dist/` to GitHub Pages (`.github/workflows/pages.yml`). The build uses relative asset paths, so it works under that `/hifdh/` path or any other.

## Using it

- Pick a surah or page and a reciter, press **Space** (or ▶), and fix your eyes on the dot.
- **Play** sets how far a session runs: **the surah** (default) plays to the end of the surah's last ayah and stops there, even when the next surah starts on the same page; or this page, 2 or 5 pages, or continuously. **Repeat** replays that 1–20 times or forever. Reciting (below) also stops at the end of the surah when Play is "the surah".
- **→** (or ⏭ beside ▶) jumps to the start of the next ayah; **←** (or ⏮) jumps back to the start of the current ayah, or to the previous ayah if you are already at (within a second of) its start. Both work while playing or paused and cross pages and surahs. **PageDown/PageUp** (or the ‹ › buttons next to the page number) turn pages; on every ‹ › pair, › goes forward. Click any word to start from it. **<** / **>** step the speed down/up through the Speed menu's values, as on YouTube. **+/−** zoom, **F** full screen.
- **On a touch screen:** tap the page to play / pause (which also brings back hidden controls); swipe left for the next ayah and right for the start of this one / the previous one; pinch to zoom; hold a word for its meaning and to play from it or make its ayah the loop's start (A) or end (B). The instructions card shows these gestures instead of keys on phones and tablets.
- **A-B loop:** press **A** to mark the current ayah as the loop start and **B** to mark the loop end (pressing the key again on the same ayah removes that point), or **Shift+click** / **Alt(Option)+click** any word to set A / B at its ayah. The A and B chips in the bottom bar show the points; their ‹ › buttons move a point one ayah later/earlier and × removes it; **C** clears both. With both set, playback runs from the start of A to the end of B and **Repeat** counts loops (the Play range is disabled meanwhile). Small A and B tags mark the loop's first word and last ayah number on the page.
- **Zoom** at its minimum keeps the entire page on screen wherever the dot is on it, so you always see the whole page you are memorizing. Zooming in makes the text larger, but the edges of the page can then go off screen.
- The screen stays on while the site is open in the foreground, so a phone doesn't dim or lock while you watch the dot (Screen Wake Lock API; the browser may refuse it, e.g. in battery saver, and it's asked for again on your next tap).
- Choosing a surah, **Shift+→** / **Shift+←**, or the › ‹ buttons beside the surah menu go to the next / previous surah and rest the dot on its first word (with the basmala read first), even when it starts part-way down a page; while playing or reciting, it carries on from there. The surah menu always shows the surah the dot is in. Repeats go back to where you started, not to the top of the page.
- **Settings:** letter-glide vs word-step tracking, motion smoothing, dot above or on the letter, theme, tajweed colours on/off, current-word highlight, edge dimming, auto-hiding controls.
- **Tajweed colours** opens the colour key. The colours are quran.com's, but printed tajweed mushafs don't share one colour scheme: this app shows madd munfaṣil in pink (quran.com's font draws it red, like muttaṣil), and you can click any rule's colour to change it to match your mushaf; your colours are saved and apply in every theme (except Firefox's dark mode, which uses fixed-colour fonts), and **Reset colours** restores the defaults.
- Reloading the site brings you back to the ayah you were on, not to the top of its page (which may be the end of the previous surah).
- **Hover over a word** to see it with its transliteration and English meaning (quran.com's word-by-word translation). While the page is moving, the popover closes once its word slides away from the pointer; words still hidden while reciting show nothing.

The fonts draw each word as a single glyph, so "letter" tracking is interpolated: within each word's timestamp the focus slides from its right edge to its left edge at a constant rate. It follows pronunciation closely but it isn't timed per letter. One exception is corrected: in an idghām with ghunnah (أَنَّهُم مَّبْعُوثُونَ) the held green letter opens the next word, but many recordings' timestamps count the hold in the previous word, which would leave the focus on the end of the line while the green letter starting the next line is held. Where that happens, the two words' combined time is shared by their spoken length (letters, madd and ghunnah beats read from the tajweed markup), so the focus moves on as the hold begins.

## Reciting from memory

Press **P** (or **🎙 Recite**) and recite aloud from the ayah under the dot, or the A-B loop if one is set. The page follows your voice: words you haven't recited yet are hidden (their places stay, so the page keeps its shape), each word appears as you say it, and the dot sits where the next word belongs. The page turns when you reach the next one.

- A word you skip is revealed in red with "Skipped: …"; a word you say differently is revealed with "Check: …", with a soft tone (Settings can turn the tone off). A taʿawwudh or basmala said before you begin, and going back to repeat the last few words, are not counted as mistakes.
- **H** reveals the next word if you're stuck — faded, in its own place on the page, right under the dot. **←** recites the current ayah again (or the previous one if you're at its start), **→** skips to the next ayah, clicking a word restarts from its ayah, **Space** pauses listening, **P** or **Esc** stops. At the end of the stretch (the surah, the loop, or the Quran) you get a summary of mistakes and hints, and **P** recites the same stretch again from its beginning.
- On a touch screen, **💡 Hint** appears in the bottom bar while reciting, swiping left / right does what → / ← do, holding a word lets you recite again from its ayah, and a tap pauses listening.
- Settings can show upcoming words faintly instead of hiding them.

Limits worth knowing: this uses the browser's speech recognition in Arabic (Chrome and Edge send audio to Google's speech service, Safari uses Apple's; Firefox has none), so it needs a microphone and a connection. It checks **words** — skipped, swapped or different words — not **tajweed** (a short madd or missing ghunnah still sounds like the right word), and the recogniser can mishear, so treat a flag as "check this word" rather than a verdict. Words must match exactly up to 7 letters, since one letter is often the whole difference (لليسرى / للعسرى).

If reciting doesn't respond, read the status line at the bottom right:

- **"Heard: …"** shows what the recogniser understood. If words appear there but the page doesn't follow, the words aren't matching the ayah you started from.
- **"Not hearing anything"** means the microphone is open but silent: check the input device in System Settings › Sound › Input and the browser's site settings.
- **"The speech-recognition service could not be reached"** or **"keeps stopping right after it starts"** means the browser's recogniser isn't working. Chromium browsers other than Google Chrome and Edge (Brave, Arc, Vivaldi, Opera…) typically lack the speech service; use Chrome, Edge or Safari. The app gives up after three failed starts rather than switching the microphone on and off.

## Code map

- `src/api.ts` — quran.com / qurancdn endpoints and types.
- `src/fonts.ts` — loads the V1 page fonts (exact print), the V4 tajweed page fonts (colour mode; OT-SVG dark build in Firefox's dark mode) and Uthmanic Hafs (verse numbers), and keeps the V4 palette rules current.
- `src/mushaf.ts` — builds a page's 15 lines (surah titles, basmala, words), fits them to one width and measures word boxes.
- `src/tajweed.ts` — tajweed colours as quran.com draws them: the V4 fonts' palettes per theme, the palette slot each rule uses, the pink munfaṣil palette and your own colours as `@font-palette-values` overrides. `src/tajweed.test.ts` specifies it (and the V4 glyph lookup in `api.ts`) with one case per colouring problem reported (munfaṣil pink; the reported ikhfāʾ / iqlāb words drawn with quran.com's own glyphs). Add a case there for any new colouring report before fixing it.
- `src/timeline.ts` — turns word timestamps into focus keyframes and samples them, moving held idghām letters onto their own word first. `src/timeline.test.ts` specifies that with the reported 83:4 case in two recordings.
- `src/engine.ts` — audio, page flips, surah transitions, range/repeat.
- `src/main.ts` — controls, settings (saved in `localStorage`), per-frame rendering.
- `src/touch.ts` — recognises taps, long-presses, swipes and pinches on the page; `main.ts` maps them to the same actions as the keys.
- `src/recite.ts` — normalises Arabic and aligns what the recogniser heard with the expected words.
- `src/listener.ts` — the browser speech-recognition session, restarted as needed.
- `src/practice.ts` — reciting mode: follows the voice, hides upcoming words, reports mistakes.
