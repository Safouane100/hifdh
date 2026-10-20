import { PAGE_COUNT, type Chapter, getChapters, getReciters } from './api';
import { Engine, type Loop, type PlayState, type RangeMode } from './engine';
import { type Script, type Theme, setTajweedColours, v4Build } from './fonts';
import { type Rule, ruleColour } from './tajweed';
import type { MushafPage, WordRef } from './mushaf';
import { Practice } from './practice';
import { SPEECH_SUPPORTED, SPEECH_UNSUPPORTED_REASON } from './listener';
import { bindGestures } from './touch';
import type { Point, TrackingMode } from './timeline';

interface Settings {
  page: number;
  /** Ayah the dot was on (`chapter:verse`), restored on reload; '' for the page's first. */
  verse: string;
  reciter: number;
  theme: Theme;
  tajweed: boolean;
  mode: TrackingMode;
  rate: number;
  /** 1 = the whole page stays on screen wherever the dot is on it; higher magnifies. */
  magnify: number;
  /** Time constant (ms) of the exponential smoothing applied to the focus point. */
  smoothing: number;
  dot: 'above' | 'on';
  highlight: boolean;
  vignette: boolean;
  autohide: boolean;
  /** Play a tone when a recitation mistake is heard. */
  beep: boolean;
  /** While reciting, show upcoming words faintly instead of hiding them. */
  peek: boolean;
  /** Your own tajweed colours by rule id (e.g. "munfasil"), overriding the defaults. */
  colors: Partial<Record<Rule, string>>;
  range: RangeMode;
  repeat: number;
  /** Settings format; see loadSettings. */
  version: number;
}

const DEFAULTS: Settings = {
  page: 1,
  verse: '',
  reciter: 7, // Mishari Rashid al-Afasy, the quran.com default
  theme: 'light',
  tajweed: true,
  mode: 'glide',
  rate: 1,
  magnify: 1,
  smoothing: 90,
  dot: 'above',
  highlight: false,
  vignette: false,
  autohide: true,
  beep: true,
  peek: false,
  colors: {},
  range: 'surah',
  repeat: 3,
  version: 3,
};

// v2: zoom became "magnify" relative to the whole-page fit. The key keeps the
// app's old "hifz" spelling so settings saved under it survive the rename.
const STORAGE_KEY = 'hifz-focus:settings:v2';

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    // Before version 3 the default range was "this page"; a stored value from
    // then is just that old default, so move it to the new one.
    if ((stored.version ?? 0) < 3) delete stored.range;
    return { ...DEFAULTS, ...stored, version: 3 };
  } catch {
    return { ...DEFAULTS };
  }
}

const settings = loadSettings();
const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  root: document.documentElement,
  viewport: $<HTMLElement>('viewport'),
  pager: $<HTMLDivElement>('pager'),
  surah: $<HTMLSelectElement>('surah'),
  page: $<HTMLInputElement>('page'),
  nextPage: $<HTMLButtonElement>('next-page'),
  nextSurah: $<HTMLButtonElement>('next-surah'),
  prevSurah: $<HTMLButtonElement>('prev-surah'),
  prevPage: $<HTMLButtonElement>('prev-page'),
  where: $<HTMLDivElement>('where'),
  reciter: $<HTMLSelectElement>('reciter'),
  play: $<HTMLButtonElement>('play'),
  prevAyah: $<HTMLButtonElement>('prev-ayah'),
  nextAyah: $<HTMLButtonElement>('next-ayah'),
  reveal: $<HTMLButtonElement>('reveal'),
  range: $<HTMLSelectElement>('range'),
  repeat: $<HTMLSelectElement>('repeat'),
  pass: $<HTMLSpanElement>('pass'),
  rate: $<HTMLSelectElement>('rate'),
  zoom: $<HTMLInputElement>('zoom'),
  status: $<HTMLSpanElement>('status'),
  flash: $<HTMLDivElement>('flash'),
  settingsPanel: $<HTMLElement>('settings'),
  legendPanel: $<HTMLElement>('legend'),
  toggleSettings: $<HTMLButtonElement>('toggle-settings'),
  toggleLegend: $<HTMLButtonElement>('toggle-legend'),
  legendList: $<HTMLUListElement>('legend-list'),
  legendNote: $<HTMLParagraphElement>('legend-note'),
  resetColours: $<HTMLButtonElement>('reset-colours'),
  loopPoints: [...document.querySelectorAll<HTMLElement>('.loop-point')],
  mode: $<HTMLSelectElement>('mode'),
  smoothing: $<HTMLInputElement>('smoothing'),
  smoothingOut: $<HTMLOutputElement>('smoothing-out'),
  dotPlace: $<HTMLSelectElement>('dot-place'),
  theme: $<HTMLSelectElement>('theme'),
  tajweed: $<HTMLInputElement>('tajweed'),
  highlight: $<HTMLInputElement>('highlight'),
  vignette: $<HTMLInputElement>('vignette-on'),
  autohide: $<HTMLInputElement>('autohide'),
  beep: $<HTMLInputElement>('beep'),
  peek: $<HTMLInputElement>('peek'),
  practice: $<HTMLButtonElement>('practice'),
  wordMenu: $<HTMLDivElement>('word-menu'),
};

const RULES: { id: Rule; name: string; desc: string }[] = [
  { id: 'lazim', name: 'Madd Lāzim', desc: 'Necessary prolongation — 6 ḥarakāt.' },
  { id: 'wajib', name: 'Madd Wājib Muttaṣil', desc: 'Long vowel followed by hamza in the same word — 4 or 5 ḥarakāt.' },
  { id: 'munfasil', name: 'Madd Jāʾiz Munfaṣil', desc: 'Long vowel at the end of a word, hamza starting the next — 4 or 5 ḥarakāt (2 when shortened). quran.com draws it red like muttaṣil.' },
  { id: 'jaiz', name: 'Madd Jāʾiz / ʿĀriḍ', desc: 'Permissible prolongation, e.g. before a letter made silent by stopping — 2, 4 or 6 ḥarakāt.' },
  { id: 'tabii', name: 'Madd Ṭabīʿī', desc: 'Normal prolongation — 2 ḥarakāt.' },
  { id: 'ghunnah', name: 'Ghunnah', desc: 'Nasalisation, 2 ḥarakāt: ikhfāʾ, iqlāb, idghām with ghunnah, mushaddad nūn/mīm.' },
  { id: 'qalqalah', name: 'Qalqalah', desc: 'Echoing bounce on a sākin ق ط ب ج د.' },
  { id: 'tafkhim', name: 'Tafkhīm', desc: 'Heavy, full-mouthed letters — the istiʿlāʾ letters and a heavy Rāʾ.' },
  { id: 'silent', name: 'Silent letters', desc: 'Written but not pronounced — hamzat al-waṣl, lām shamsiyyah, a merged noon or meem, etc.' },
];

function renderLegend(): void {
  ui.legendNote.textContent = settings.tajweed
    ? 'Colours are drawn by quran.com’s tajweed fonts (King Fahd Complex QCF V4). Printed tajweed mushafs use different colour schemes: click a colour to change it to match yours.'
    : 'Exact print calligraphy is shown, which has no colours. Turn on “Tajweed colours” in Settings to colour the letters.';
  ui.resetColours.hidden = Object.keys(settings.colors).length === 0;
  ui.legendList.replaceChildren(
    ...RULES.map((rule) => {
      const li = document.createElement('li');
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.className = 'swatch';
      picker.title = `Change the colour for ${rule.name}`;
      picker.value = ruleColour(settings.theme, rule.id, settings.colors);
      picker.addEventListener('input', () => {
        settings.colors[rule.id] = picker.value;
        save();
        setTajweedColours(settings.theme, settings.colors);
        ui.resetColours.hidden = false;
      });
      const text = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'rule-name';
      name.textContent = rule.name;
      const desc = document.createElement('div');
      desc.className = 'rule-desc';
      desc.textContent = rule.desc;
      text.append(name, desc);
      li.append(picker, text);
      return li;
    }),
  );
}

function applyLook(): void {
  ui.root.dataset.theme = settings.theme;
  ui.root.dataset.dot = settings.dot;
  document.body.classList.toggle('show-highlight', settings.highlight);
  document.body.classList.toggle('vignette', settings.vignette);
  document.body.classList.toggle('peek-ahead', settings.peek);
  setTajweedColours(settings.theme, settings.colors);
  renderLegend();
}

function setStatus(text: string, error = false): void {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', error);
}

function setSpeed(rate: number): void {
  settings.rate = rate;
  ui.rate.value = String(rate);
  save();
  engine.setRate(rate);
}

let flashTimer = 0;
/** Briefly show a value in the middle of the screen, like YouTube's speed readout. */
function flash(text: string, ms = 700): void {
  ui.flash.textContent = text;
  ui.flash.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => ui.flash.classList.remove('show'), ms);
}

// --- Focus rendering ----------------------------------------------------

let engine: Engine;
let chapters: Chapter[] = [];
let focus: Point | undefined;
let lastFrame = performance.now();
let highlighted: HTMLElement | undefined;
/** Unscaled size of the visible page; every page has the same fixed size. */
let pageSize = { w: 1, h: 1 };
const MAX_MAGNIFY = 5;

/** Must match `.mushaf-page { font-size }` in style.css. */
const PAGE_FONT_PX = 32;

// The page layer has `will-change: transform` so it glides as one bitmap with
// subpixel precision, but Chrome then keeps that bitmap at the scale it was
// painted at. Once the scale (zoom, window size) has held for a moment, drop
// `will-change` for one frame so the page is repainted sharp at the new scale.
const REPAINT_AFTER_MS = 250;
let lastScale = 0;
let scaleSince = 0;
let paintedScale = 0;

// --- Word popover -----------------------------------------------------------

let popWord: WordRef | undefined;
let pointer = { x: -1, y: -1 };
const popover = {
  el: $<HTMLDivElement>('word-pop'),
  arabic: document.querySelector<HTMLElement>('#word-pop .pop-arabic')!,
  translit: document.querySelector<HTMLElement>('#word-pop .pop-translit')!,
  translation: document.querySelector<HTMLElement>('#word-pop .pop-translation')!,
};

/** The visible word under a screen point (hidden, not-yet-recited words don't count). */
function wordAt(x: number, y: number): WordRef | undefined {
  const key = document.elementFromPoint(x, y)?.closest<HTMLElement>('.w:not(.end)')?.dataset.k;
  return key ? engine.page?.words.get(key) : undefined;
}

/** Show a word's translation like quran.com's hover popover; only pointer movement calls this. */
function showPopover(word: WordRef | undefined): void {
  if (word === popWord) return;
  popWord = word?.translation ? word : undefined;
  popover.el.hidden = !popWord;
  if (!popWord) return;
  popover.arabic.textContent = popWord.uthmani;
  popover.translit.textContent = popWord.transliteration;
  popover.translation.textContent = popWord.translation;
  placePopover();
}

/**
 * Keep the popover on its word as the page moves. While playing the page slides
 * under a still pointer; once the word has left the pointer the popover closes
 * rather than jumping to whatever passes underneath.
 */
function placePopover(): void {
  if (!popWord) return;
  if (wordAt(pointer.x, pointer.y) !== popWord) {
    showPopover(undefined);
    return;
  }
  const r = popWord.el.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = popover.el;
  const gap = 10;
  const below = r.top - h - gap < 8;
  const top = below ? r.bottom + gap : r.top - h - gap;
  const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
  popover.el.style.transform = `translate(${left}px, ${top}px)`;
  popover.el.classList.toggle('below', below);
}

// --- Word menu: a long-press on a touch screen ---------------------------------

/** The word the menu is open for. */
let menuWord: WordRef | undefined;
const wordMenu = {
  arabic: ui.wordMenu.querySelector<HTMLElement>('.pop-arabic')!,
  translit: ui.wordMenu.querySelector<HTMLElement>('.pop-translit')!,
  translation: ui.wordMenu.querySelector<HTMLElement>('.pop-translation')!,
  play: ui.wordMenu.querySelector<HTMLButtonElement>('[data-act="play"]')!,
  a: ui.wordMenu.querySelector<HTMLButtonElement>('[data-act="a"]')!,
  b: ui.wordMenu.querySelector<HTMLButtonElement>('[data-act="b"]')!,
};

/** What hovering and clicking do with a mouse: the word's meaning, start from it, set the loop at its ayah. */
function openWordMenu(word: WordRef): void {
  menuWord = word;
  const verseKey = word.key.slice(0, word.key.lastIndexOf(':'));
  wordMenu.arabic.textContent = word.uthmani;
  wordMenu.translit.textContent = word.transliteration;
  wordMenu.translation.textContent = word.translation;
  wordMenu.play.textContent = practice.active ? '🎙 Recite from this ayah' : '▶ Play from here';
  wordMenu.a.textContent = loop.a?.verseKey === verseKey ? 'Remove loop start (A)' : 'Loop from this ayah (A)';
  wordMenu.b.textContent = loop.b?.verseKey === verseKey ? 'Remove loop end (B)' : 'Loop to this ayah (B)';
  ui.wordMenu.hidden = false;
  navigator.vibrate?.(15);
}

function closeWordMenu(): void {
  menuWord = undefined;
  ui.wordMenu.hidden = true;
}

function renderFrame(now: number): void {
  const dt = Math.min(now - lastFrame, 100);
  lastFrame = now;
  const frame = engine.frame();
  const target = frame.focus;
  if (!focus || frame.snap || settings.smoothing === 0) {
    focus = { ...target };
  } else {
    const k = 1 - Math.exp(-dt / settings.smoothing);
    focus.x += (target.x - focus.x) * k;
    focus.y += (target.y - focus.y) * k;
  }
  // The dot is fixed at the centre, so the page can extend a full page-width to
  // either side of it and a full page-height above or below. Fitting that keeps
  // the entire page visible at all times; "magnify" trades that for size.
  const fit = Math.min(window.innerWidth / 2 / pageSize.w, window.innerHeight / 2 / pageSize.h);
  const scale = fit * settings.magnify;
  const cx = window.innerWidth / 2;
  // "above": the dot sits just over the letter so it never covers the text.
  const cy = window.innerHeight / 2 + (settings.dot === 'above' ? PAGE_FONT_PX * 0.8 * scale : 0);
  ui.pager.style.transform = `translate3d(${cx - focus.x * scale}px, ${cy - focus.y * scale}px, 0) scale(${scale})`;
  if (scale !== lastScale) {
    lastScale = scale;
    scaleSince = now;
  } else if (scale !== paintedScale && now - scaleSince > REPAINT_AFTER_MS) {
    paintedScale = scale;
    ui.pager.style.willChange = 'auto';
    requestAnimationFrame(() => (ui.pager.style.willChange = ''));
  }

  const active = frame.activeKey ? engine.page?.words.get(frame.activeKey)?.el : undefined;
  if (active !== highlighted) {
    highlighted?.classList.remove('active');
    active?.classList.add('active');
    highlighted = active;
  }
  syncWhere();
  placePopover();
  requestAnimationFrame(renderFrame);
}

// --- Navigation -----------------------------------------------------------

const scriptOf = (tajweed: boolean): Script => (tajweed ? 'tajweed' : 'print');

/** Go to a page, resting on `focusKey` (a word on it) instead of its first word. */
function goTo(page: number, focusKey?: string): void {
  const n = Math.min(PAGE_COUNT, Math.max(1, Math.round(page)));
  if (practice.active) stopPractice();
  if (engine.playing) void engine.start(n, focusKey);
  else void engine.open(n, focusKey);
}

/** Go to the start of a surah (its basmala, then ayah 1), keeping playing or reciting if active. */
function openSurah(chapter: Chapter): void {
  if (practice.active) {
    const from = `${chapter.id}:1`;
    void practice.start({ verseKey: from, page: chapter.pages[0] }, practiceEnd(from));
    return;
  }
  goTo(chapter.pages[0], `${chapter.id}:1:1`);
}

/** Next (`1`) or previous (`-1`) surah from the one the dot is in. */
function goToSurah(dir: 1 | -1): void {
  const target = chapters[shownChapter - 1 + dir];
  if (target) openSurah(target);
}

/** Surah of the ayah under the dot, as shown in the header. */
let shownChapter = 1;
let shownVerse = '';

/** Keep the surah picker and the header on the ayah the dot is on, which may change mid-page. */
function syncWhere(): void {
  const here = engine.currentVerse();
  if (!here || here.verseKey === shownVerse) return;
  shownVerse = here.verseKey;
  settings.verse = here.verseKey;
  save();
  const [c, v] = here.verseKey.split(':').map(Number);
  shownChapter = c;
  ui.surah.value = String(c);
  ui.where.textContent = `${chapters[c - 1].name_simple} ${c}:${v} · page ${here.page} of ${PAGE_COUNT}`;
}

function onPage(page: MushafPage): void {
  settings.page = page.page;
  save();
  ui.page.value = String(page.page);
  highlighted = undefined;
  pageSize = { w: page.el.offsetWidth, h: page.el.offsetHeight };
  paintLoop();
  practice?.paint(page);
}

function onState(state: PlayState, detail?: string): void {
  const playing = state === 'playing' || (state === 'loading' && engine.playing);
  document.body.classList.toggle('playing', playing);
  // The instructions have done their job once the first session has started.
  if (playing) document.body.classList.add('played');
  ui.play.textContent = playing ? '❚❚' : '▶';
  ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const messages: Record<PlayState, string> = {
    idle: '',
    loading: detail ?? 'Loading…',
    playing: '',
    paused: detail ?? 'Paused',
    finished: 'Session complete',
    error: detail ?? 'Something went wrong',
  };
  // While reciting, the status line belongs to the practice session.
  if (!practice?.active || state === 'error') setStatus(messages[state], state === 'error');
  if (!playing) showControls();
}

// --- Recitation practice --------------------------------------------------

let practice: Practice;

function startPractice(): void {
  // With an A-B loop, recite exactly the loop; otherwise from the ayah under the dot.
  const looping = loop.a && loop.b;
  const from = looping ? loop.a : engine.currentVerse();
  if (!from) return;
  document.body.classList.add('reciting');
  ui.practice.textContent = '■ Stop reciting';
  void practice.start(from, looping ? loop.b!.verseKey : practiceEnd(from.verseKey));
}

/** Where reciting from `verseKey` stops without a loop: the surah's end when playing "the surah". */
function practiceEnd(verseKey: string): string | undefined {
  if (settings.range !== 'surah') return undefined;
  const chapter = chapters[Number(verseKey.split(':')[0]) - 1];
  return `${chapter.id}:${chapter.verses_count}`;
}

function stopPractice(): void {
  practice.stop();
  document.body.classList.remove('reciting');
  ui.practice.textContent = '🎙 Recite';
  setStatus('');
}

function onMistake(kind: 'missed' | 'wrong', words: string[]): void {
  flash(`${kind === 'missed' ? 'Skipped' : 'Check'}: ${words.join(' ')}`, 1800);
  if (settings.beep) beep();
}

let audioCtx: AudioContext | undefined;
/** A short, soft low tone: noticeable without being alarming. */
function beep(): void {
  audioCtx ??= new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = 330;
  gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.26);
}

function onPass(done: number, total: number): void {
  ui.pass.textContent = total === 1 ? '' : `Pass ${done} / ${total === 0 ? '∞' : total}`;
}

// --- A-B loop -------------------------------------------------------------

let loop: Loop = {};

function onLoop(next: Loop): void {
  loop = next;
  const active = Boolean(loop.a && loop.b);
  for (const pointEl of ui.loopPoints) {
    const point = loop[pointEl.dataset.point as 'a' | 'b'];
    pointEl.classList.toggle('is-set', Boolean(point));
    const [c, v] = point?.verseKey.split(':').map(Number) ?? [];
    pointEl.querySelector('.at')!.textContent = point ? `${chapters[c - 1].name_simple} ${v}` : '';
  }
  // The loop, not the "Play" range, decides where each pass ends.
  ui.range.disabled = active;
  ui.range.title = active ? 'The A-B loop sets what plays; clear it to use this' : '';
  paintLoop();
}

/** Tag A's first word and B's ayah number on the visible page. */
function paintLoop(): void {
  const page = engine.page;
  if (!page) return;
  for (const ref of page.words.values()) {
    const verseKey = ref.key.slice(0, ref.key.lastIndexOf(':'));
    ref.el.classList.toggle('loop-a', ref.key === `${loop.a?.verseKey}:1`);
    ref.el.classList.toggle('loop-b', ref.kind === 'end' && verseKey === loop.b?.verseKey);
  }
}

// --- Immersive mode: hide controls while playing and the mouse is still ------

let idleTimer = 0;
function showControls(): void {
  document.body.classList.remove('immersive');
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (settings.autohide && engine.playing) document.body.classList.add('immersive');
  }, 2500);
}

// --- Actions shared by keys, buttons and touch gestures ----------------------

/** Space / a tap: play or pause; while reciting, pause or resume listening. */
function togglePlay(): void {
  if (practice.active) practice.toggleListening();
  else engine.toggle();
}

/** → / ← / a swipe / ⏭ ⏮: next ayah, or the start of this one (the previous one if already there); while reciting, recite from there. */
function stepAyah(dir: 1 | -1): void {
  if (practice.active) void engine.ayahTarget(dir).then((target) => target && practice.restartAt(target));
  else void engine.stepAyah(dir);
}

/** Start from a clicked word; while reciting, recite again from its ayah. */
function startFromWord(key: string): void {
  const page = engine.page;
  if (!page) return;
  if (practice.active) void practice.restartAt({ verseKey: key.slice(0, key.lastIndexOf(':')), page: page.page });
  else void engine.start(page.page, key);
}

/** Set the loop start / end at an ayah on the page, or remove it if it is already there. */
function toggleLoopPoint(which: 'a' | 'b', verseKey: string): void {
  const page = engine.page;
  if (!page) return;
  engine.setPoint(which, loop[which]?.verseKey === verseKey ? undefined : { verseKey, page: page.page });
}

/** Zoom, kept to the slider's range; callers save once the change is done. */
function setMagnify(magnify: number): void {
  settings.magnify = Math.min(MAX_MAGNIFY, Math.max(1, magnify));
  ui.zoom.value = String(settings.magnify);
}

// --- Wiring ---------------------------------------------------------------

function bindControls(): void {
  // A surah starts at its first ayah, which is often part-way down its first page.
  ui.surah.addEventListener('change', () => openSurah(chapters[Number(ui.surah.value) - 1]));
  ui.nextSurah.addEventListener('click', () => goToSurah(1));
  ui.prevSurah.addEventListener('click', () => goToSurah(-1));
  ui.page.addEventListener('change', () => goTo(Number(ui.page.value)));
  ui.nextPage.addEventListener('click', () => goTo((engine.page?.page ?? 1) + 1));
  ui.prevPage.addEventListener('click', () => goTo((engine.page?.page ?? 1) - 1));
  ui.play.addEventListener('click', () => engine.toggle());

  ui.reciter.addEventListener('change', () => {
    settings.reciter = Number(ui.reciter.value);
    save();
    void engine.reconfigure({ reciter: settings.reciter });
  });
  const updateRange = () => {
    settings.range = ui.range.value as RangeMode;
    settings.repeat = Number(ui.repeat.value);
    save();
    engine.setRange(settings.range, settings.repeat);
  };
  ui.range.addEventListener('change', updateRange);
  ui.repeat.addEventListener('change', updateRange);
  ui.rate.addEventListener('change', () => setSpeed(Number(ui.rate.value)));
  ui.zoom.addEventListener('input', () => {
    settings.magnify = Number(ui.zoom.value);
    save();
  });
  ui.mode.addEventListener('change', () => {
    settings.mode = ui.mode.value as TrackingMode;
    save();
    engine.setMode(settings.mode);
  });
  ui.smoothing.addEventListener('input', () => {
    settings.smoothing = Number(ui.smoothing.value);
    ui.smoothingOut.value = `${settings.smoothing} ms`;
    save();
  });
  ui.dotPlace.addEventListener('change', () => {
    settings.dot = ui.dotPlace.value as Settings['dot'];
    save();
    applyLook();
  });
  ui.theme.addEventListener('change', () => {
    settings.theme = ui.theme.value as Theme;
    save();
    const build = v4Build();
    applyLook();
    // Firefox's dark mode needs different tajweed font files (see fonts.ts).
    if (v4Build() !== build) void engine.reconfigure({});
  });
  ui.tajweed.addEventListener('change', () => {
    settings.tajweed = ui.tajweed.checked;
    save();
    applyLook();
    void engine.reconfigure({ script: scriptOf(settings.tajweed) });
  });
  const bindCheck = (input: HTMLInputElement, key: 'highlight' | 'vignette' | 'autohide' | 'beep' | 'peek') => {
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      save();
      applyLook();
    });
  };
  bindCheck(ui.highlight, 'highlight');
  bindCheck(ui.vignette, 'vignette');
  bindCheck(ui.autohide, 'autohide');
  bindCheck(ui.beep, 'beep');
  bindCheck(ui.peek, 'peek');
  ui.practice.addEventListener('click', () => (practice.active ? stopPractice() : startPractice()));

  const togglePanel = (panel: HTMLElement, other: HTMLElement) => {
    other.hidden = true;
    panel.hidden = !panel.hidden;
  };
  ui.toggleSettings.addEventListener('click', () => togglePanel(ui.settingsPanel, ui.legendPanel));
  ui.toggleLegend.addEventListener('click', () => togglePanel(ui.legendPanel, ui.settingsPanel));
  ui.resetColours.addEventListener('click', () => {
    settings.colors = {};
    save();
    setTajweedColours(settings.theme, settings.colors);
    renderLegend();
  });

  ui.pager.addEventListener('click', (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('.w')?.dataset.k;
    if (!key) return;
    // Shift+click / Alt(Option)+click set the loop start / end at that ayah.
    if (e.shiftKey || e.altKey) {
      e.preventDefault();
      toggleLoopPoint(e.shiftKey ? 'a' : 'b', key.slice(0, key.lastIndexOf(':')));
    } else startFromWord(key);
  });
  ui.prevAyah.addEventListener('click', () => stepAyah(-1));
  ui.nextAyah.addEventListener('click', () => stepAyah(1));
  ui.reveal.addEventListener('click', () => practice.hint());

  ui.wordMenu.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    const word = menuWord;
    if (!act || !word) return;
    closeWordMenu();
    if (act === 'play') startFromWord(word.key);
    else toggleLoopPoint(act === 'a' ? 'a' : 'b', word.key.slice(0, word.key.lastIndexOf(':')));
  });
  let pinchFrom = 1;
  bindGestures(ui.viewport, {
    tap: () => {
      // A tap away from the open menu just closes it.
      if (menuWord) closeWordMenu();
      else togglePlay();
      showControls();
    },
    longPress: (x, y) => {
      const word = wordAt(x, y);
      if (word) openWordMenu(word);
    },
    swipe: (dir) => {
      closeWordMenu();
      stepAyah(dir);
    },
    pinchStart: () => {
      closeWordMenu();
      pinchFrom = settings.magnify;
    },
    pinch: (ratio) => setMagnify(pinchFrom * ratio),
    pinchEnd: save,
  });

  for (const pointEl of ui.loopPoints) {
    const which = pointEl.dataset.point as 'a' | 'b';
    pointEl.querySelector('.set')!.addEventListener('click', () => engine.markPoint(which));
    pointEl.querySelector('.clear')!.addEventListener('click', () => engine.setPoint(which, undefined));
    for (const nudge of pointEl.querySelectorAll<HTMLButtonElement>('.nudge')) {
      nudge.addEventListener('click', () => void engine.nudgePoint(which, Number(nudge.dataset.dir) as 1 | -1));
    }
  }

  document.addEventListener('mousemove', showControls);
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    pointer = { x: e.clientX, y: e.clientY };
    showPopover(wordAt(pointer.x, pointer.y));
  });
  document.documentElement.addEventListener('pointerleave', () => showPopover(undefined));
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.matches('input[type=number], select') && e.key !== 'Escape') return;
    // Letter shortcuts must not swallow browser shortcuts like Cmd/Ctrl+A.
    if (e.metaKey || e.ctrlKey) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      // → moves forward (next ayah), ← back. With Shift: by surah.
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.shiftKey) goToSurah(dir);
        else stepAyah(dir);
        break;
      }
      case 'PageDown':
        goTo((engine.page?.page ?? 1) + 1);
        break;
      case 'PageUp':
        goTo((engine.page?.page ?? 1) - 1);
        break;
      case 'a':
      case 'A':
        engine.markPoint('a');
        break;
      case 'b':
      case 'B':
        engine.markPoint('b');
        break;
      case 'c':
      case 'C':
        engine.clearLoop();
        break;
      case '+':
      case '=':
        setMagnify(settings.magnify * 1.1);
        save();
        break;
      case '-':
      case '_':
        setMagnify(settings.magnify / 1.1);
        save();
        break;
      // YouTube's speed keys, stepping through the Speed dropdown's own values.
      case '>':
      case '<': {
        const speeds = [...ui.rate.options].map((o) => Number(o.value));
        const i = speeds.indexOf(settings.rate);
        const next = speeds[Math.min(speeds.length - 1, Math.max(0, i + (e.key === '>' ? 1 : -1)))];
        setSpeed(next);
        flash(`${next}×`);
        break;
      }
      case 'f':
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
        break;
      case 'Escape':
        ui.settingsPanel.hidden = true;
        ui.legendPanel.hidden = true;
        closeWordMenu();
        if (practice.active) stopPractice();
        break;
      case 'p':
      case 'P':
        // P starts reciting; while reciting it stops; after a finished stretch it
        // recites the same stretch again from its beginning.
        if (practice.done) void practice.again();
        else if (practice.active) stopPractice();
        else if (SPEECH_SUPPORTED) startPractice();
        else setStatus(SPEECH_UNSUPPORTED_REASON, true);
        break;
      case 'h':
      case 'H':
        practice.hint();
        break;
      default:
        return;
    }
    showControls();
  });
}

function syncInputs(): void {
  ui.range.value = settings.range;
  ui.repeat.value = String(settings.repeat);
  ui.rate.value = String(settings.rate);
  ui.zoom.value = String(settings.magnify);
  ui.mode.value = settings.mode;
  ui.smoothing.value = String(settings.smoothing);
  ui.smoothingOut.value = `${settings.smoothing} ms`;
  ui.dotPlace.value = settings.dot;
  ui.theme.value = settings.theme;
  ui.tajweed.checked = settings.tajweed;
  ui.highlight.checked = settings.highlight;
  ui.vignette.checked = settings.vignette;
  ui.autohide.checked = settings.autohide;
  ui.beep.checked = settings.beep;
  ui.peek.checked = settings.peek;
}

// --- Screen wake lock -------------------------------------------------------

let wakeLock: WakeLockSentinel | undefined;
let wakeLockPending = false;

/**
 * Keep the screen on while the site is visible: you watch the dot without
 * touching the screen, so a phone would otherwise dim and lock. The browser
 * releases the lock whenever the tab is hidden (and may refuse it, e.g. before
 * any interaction), so this is called again on return and on every tap or key.
 */
async function keepScreenAwake(): Promise<void> {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  if (wakeLockPending || (wakeLock && !wakeLock.released)) return;
  wakeLockPending = true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Refused for now; the next tap, key or return to the tab asks again.
  } finally {
    wakeLockPending = false;
  }
}

async function main(): Promise<void> {
  applyLook();
  syncInputs();
  setStatus('Loading…');
  try {
    const [chapterList, reciters] = await Promise.all([getChapters(), getReciters()]);
    chapters = chapterList;
    ui.surah.replaceChildren(
      ...chapters.map((c) => new Option(`${c.id}. ${c.name_simple} — ${c.name_arabic}`, String(c.id))),
    );
    ui.reciter.replaceChildren(
      ...reciters.map((r) => new Option(r.style ? `${r.name} · ${r.style}` : r.name, String(r.id))),
    );
    if (!reciters.some((r) => r.id === settings.reciter)) settings.reciter = reciters[0]?.id ?? DEFAULTS.reciter;
    ui.reciter.value = String(settings.reciter);

    engine = new Engine(
      ui.pager,
      chapters,
      {
        reciter: settings.reciter,
        script: scriptOf(settings.tajweed),
        mode: settings.mode,
        rate: settings.rate,
        range: settings.range,
        repeat: settings.repeat,
      },
      { page: onPage, state: onState, pass: onPass, loop: onLoop },
    );
    practice = new Practice(engine, chapters, {
      status: (message) => setStatus(message),
      mistake: onMistake,
      stopped: (reason) => {
        stopPractice();
        setStatus(reason, true);
      },
    });
    if (!SPEECH_SUPPORTED) {
      ui.practice.disabled = true;
      ui.practice.title = SPEECH_UNSUPPORTED_REASON;
    }
    bindControls();
    void keepScreenAwake();
    document.addEventListener('visibilitychange', () => void keepScreenAwake());
    document.addEventListener('pointerdown', () => void keepScreenAwake());
    document.addEventListener('keydown', () => void keepScreenAwake());
    requestAnimationFrame(renderFrame);
    // Come back to the ayah you were on, not the top of its page (which may be
    // the end of the previous surah).
    await engine.open(settings.page, settings.verse ? `${settings.verse}:1` : undefined);
  } catch (err) {
    console.error(err);
    setStatus(`Could not reach quran.com: ${err instanceof Error ? err.message : err}`, true);
  }
}

void main();
