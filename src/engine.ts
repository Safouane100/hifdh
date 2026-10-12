import {
  type Chapter,
  type ChapterAudio,
  PAGE_COUNT,
  getChapterAudio,
  wordOrder,
} from './api';
import { type Script, v4Build } from './fonts';
import { type Box, type MushafPage, buildPage } from './mushaf';
import {
  type Keyframe,
  type Point,
  type TimedWord,
  type TrackingMode,
  buildKeyframes,
  flattenSegments,
  lastStartedWord,
  retimeHeldStarts,
  sample,
} from './timeline';

export type PlayState = 'idle' | 'loading' | 'playing' | 'paused' | 'finished' | 'error';

/** How far playback runs from the page it was started on before stopping or repeating. */
export type RangeMode = 'page' | 'pages2' | 'pages5' | 'surah' | 'continuous';

export interface EngineOptions {
  reciter: number;
  script: Script;
  mode: TrackingMode;
  rate: number;
  range: RangeMode;
  /** Passes over the range; 0 repeats forever. */
  repeat: number;
}

/** An ayah, with the page it starts on. */
export interface VersePoint {
  verseKey: string;
  page: number;
}

/** A-B loop: from the start of ayah `a` to the end of ayah `b`. Active once both are set. */
export interface Loop {
  a?: VersePoint;
  b?: VersePoint;
}

export interface EngineEvents {
  page(page: MushafPage): void;
  state(state: PlayState, detail?: string): void;
  pass(done: number, total: number): void;
  loop(loop: Loop): void;
}

export interface Frame {
  focus: Point;
  /** Word currently being recited, if it is on the visible page. */
  activeKey?: string;
  /** True once after the visible page changes: jump, don't animate. */
  snap: boolean;
}

function orderOfKey(key: string): number {
  const [c, v, p] = key.split(':').map(Number);
  return wordOrder(c, v, p);
}

/** Order of an ayah's last possible word, for "after this ayah" comparisons. */
const verseEndOrder = (verseKey: string) => orderOfKey(`${verseKey}:999`);

// → within this long after an ayah starts goes to the previous ayah instead of
// restarting this one, like a music player's "previous track".
const AT_START_MS = 1000;
const SEEK_SLOP_MS = 80;

/** Where one pass of playback runs: pages `start`–`end`, and if set, only up to the end of ayah `stopAfter`. */
interface PassRange {
  start: number;
  end: number;
  stopAfter?: string;
}

export class Engine {
  readonly audio = new Audio();
  page?: MushafPage;
  /** The page after `page` once preloaded, so a hold across the page break is timed too. */
  private nextPage?: MushafPage;
  private chapterAudio?: { reciter: number; data: ChapterAudio };
  /** The surah's word timings as the segment data gives them. */
  private segments: TimedWord[] = [];
  /** `segments` with held idghām letters moved to their own word (see `retimeHeldStarts`). */
  private words: TimedWord[] = [];
  private keyframes: Keyframe[] = [];
  private restingKey?: string;
  private range: PassRange = { start: 1, end: 1 };
  private sessionStart: { page: number; wordKey?: string } = { page: 1 };
  private passesDone = 0;
  private token = 0;
  private advancing = false;
  private finished = false;
  private lastActiveKey?: string;
  private loop: Loop = {};
  /** Ayah an arrow-key jump is heading to, so repeated presses keep counting from it. */
  private navTarget?: VersePoint & { play: boolean };
  /** Most recently requested page; may still be loading, unlike `page`. */
  private requestedPage = 1;
  private snapPending = true;
  private lastCt = -1;
  private lastPerf = 0;

  constructor(
    private readonly stage: HTMLElement,
    private readonly chapters: Chapter[],
    readonly opts: EngineOptions,
    private readonly events: EngineEvents,
  ) {
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => void this.onChapterEnded());
    this.audio.addEventListener('play', () => this.events.state('playing'));
    this.audio.addEventListener('pause', () => {
      if (!this.audio.ended && !this.advancing && !this.finished) this.events.state('paused');
    });
    this.audio.addEventListener('waiting', () => this.events.state('loading', 'Buffering audio…'));
    this.audio.addEventListener('playing', () => this.events.state('playing'));
  }

  get playing(): boolean {
    return !this.audio.paused;
  }

  /** Show a page without playing; focus rests on `focusKey` (e.g. a surah's first word) or the page's first word. */
  async open(pageNumber: number, focusKey?: string): Promise<void> {
    const token = ++this.token;
    this.audio.pause();
    this.events.state('loading', `Loading page ${pageNumber}…`);
    try {
      const page = await this.show(pageNumber);
      if (token !== this.token) return;
      this.restingKey = focusKey && page.words.has(focusKey) ? focusKey : page.firstWord.key;
      this.keyframes = [];
      this.events.state('idle');
    } catch (err) {
      if (token === this.token) this.fail(err);
    }
  }

  /** Start a fresh session on `pageNumber` (optionally from a specific word). */
  async start(pageNumber: number, wordKey?: string): Promise<void> {
    this.passesDone = 0;
    // Repeats go back to where the session began (or to A when looping), not
    // the top of the page.
    const a = this.activeLoop()?.a;
    this.sessionStart = a ? { page: a.page, wordKey: `${a.verseKey}:1` } : { page: pageNumber, wordKey };
    this.range = this.computeRange(pageNumber, wordKey);
    this.events.pass(1, this.opts.repeat);
    await this.playFrom(pageNumber, wordKey);
  }

  /**
   * Arrow-key navigation. `1` goes to the start of the next ayah; `-1` goes to
   * the start of the current ayah, or of the previous one if already at the
   * start. Keeps playing if playing; otherwise just moves the dot.
   */
  async stepAyah(dir: 1 | -1): Promise<void> {
    const here = this.position();
    if (!here) return;
    const target = dir === 1 || here.atStart ? this.adjacentVerse(here.verseKey, dir) : here.verseKey;
    if (!target) return;
    // Recorded before any await, so a second press made while this jump is still
    // loading counts from this ayah (and keeps its play/pause intent) rather than
    // from where the audio still is.
    const nav = { verseKey: target, page: here.page, play: this.navTarget?.play ?? this.playing };
    this.navTarget = nav;
    try {
      nav.page = await this.pageOfVerse(target, here.page);
      if (nav.play) await this.playFrom(nav.page, `${target}:1`);
      else await this.open(nav.page, `${target}:1`);
    } catch (err) {
      this.fail(err);
    } finally {
      if (this.navTarget === nav) this.navTarget = undefined;
    }
  }

  /**
   * The ayah `stepAyah(dir)` would go to, without going there: next ayah for
   * `1`; for `-1` the current ayah, or the previous one if already at its start.
   */
  async ayahTarget(dir: 1 | -1): Promise<VersePoint | undefined> {
    const here = this.position();
    if (!here) return undefined;
    const target = dir === 1 || here.atStart ? this.adjacentVerse(here.verseKey, dir) : here.verseKey;
    if (!target) return undefined;
    return { verseKey: target, page: await this.pageOfVerse(target, here.page) };
  }

  /** Rest the dot on a word with the audio stopped (recitation practice), turning pages as needed. */
  async focusWord(pageNumber: number, key: string): Promise<void> {
    const onPage = this.page?.page === pageNumber && this.page.words.has(key);
    if (onPage && !this.playing && this.keyframes.length === 0) {
      this.restingKey = key;
      return;
    }
    await this.open(pageNumber, key);
  }

  /** The ayah under the dot, as a loop point. */
  currentVerse(): VersePoint | undefined {
    const here = this.position();
    return here && { verseKey: here.verseKey, page: here.page };
  }

  /** Set A or B at the ayah under the dot; doing it again on the same ayah removes it. */
  markPoint(which: 'a' | 'b'): void {
    const here = this.currentVerse();
    if (!here) return;
    this.setPoint(which, this.loop[which]?.verseKey === here.verseKey ? undefined : here);
  }

  setPoint(which: 'a' | 'b', point: VersePoint | undefined): void {
    this.loop[which] = point;
    const { a, b } = this.loop;
    if (a && b && verseEndOrder(b.verseKey) < verseEndOrder(a.verseKey)) this.loop = { a: b, b: a };
    const active = this.activeLoop();
    if (active) {
      this.sessionStart = { page: active.a.page, wordKey: `${active.a.verseKey}:1` };
      this.passesDone = 0;
      this.events.pass(1, this.opts.repeat);
    }
    this.range = this.computeRange(this.sessionStart.page, this.sessionStart.wordKey);
    this.events.loop({ ...this.loop });
  }

  /** Move A or B one ayah later (`1`) or earlier (`-1`). */
  async nudgePoint(which: 'a' | 'b', dir: 1 | -1): Promise<void> {
    const point = this.loop[which];
    const target = point && this.adjacentVerse(point.verseKey, dir);
    if (!point || !target) return;
    try {
      this.setPoint(which, { verseKey: target, page: await this.pageOfVerse(target, point.page) });
    } catch (err) {
      this.fail(err);
    }
  }

  clearLoop(): void {
    this.loop = {};
    this.setPoint('a', undefined);
  }

  toggle(): void {
    if (!this.page) return;
    if (this.playing) this.audio.pause();
    else if (!this.chapterAudio || this.audio.ended || this.keyframes.length === 0) {
      void this.start(this.page.page, this.restingKey);
    } else void this.resume();
  }

  setRate(rate: number): void {
    this.opts.rate = rate;
    this.audio.playbackRate = rate;
  }

  setMode(mode: TrackingMode): void {
    this.opts.mode = mode;
    this.rebuildKeyframes();
  }

  setRange(range: RangeMode, repeat: number): void {
    this.opts.range = range;
    this.opts.repeat = repeat;
    if (this.page) this.range = this.computeRange(this.sessionStart.page, this.sessionStart.wordKey);
    this.events.pass(Math.min(this.passesDone + 1, repeat || Infinity), repeat);
  }

  /** Reciter or script change: reload what's needed and continue where we were. */
  async reconfigure(changes: Partial<Pick<EngineOptions, 'reciter' | 'script'>>): Promise<void> {
    Object.assign(this.opts, changes);
    if (!this.page) return;
    const wasPlaying = this.playing;
    const word = this.lastActiveKey ?? this.restingKey;
    if (changes.reciter !== undefined) this.chapterAudio = undefined;
    if (wasPlaying) {
      await this.playFrom(this.requestedPage, word);
    } else {
      const token = ++this.token;
      this.audio.pause();
      try {
        const page = await this.show(this.requestedPage);
        if (token !== this.token) return;
        this.restingKey = word && page.words.has(word) ? word : page.firstWord.key;
        this.keyframes = [];
        this.events.state('idle');
      } catch (err) {
        if (token === this.token) this.fail(err);
      }
    }
  }

  /** Called every animation frame by the UI. */
  frame(): Frame {
    const snap = this.snapPending;
    this.snapPending = false;
    const page = this.page;
    if (!page) return { focus: { x: 0, y: 0 }, snap };
    const t = this.now();
    let activeKey: string | undefined;
    if (this.chapterAudio && this.keyframes.length > 0) {
      const word = lastStartedWord(this.words, t);
      if (word) {
        if (this.playing && !this.advancing) {
          const order = orderOfKey(word.key);
          // The first word after the pass's last ayah (loop B, or the surah's
          // last ayah) has started: the pass is over.
          const stop = this.range.stopAfter;
          if (stop && order > verseEndOrder(stop)) void this.exclusive(() => this.finishPass());
          else if (order > page.lastOrder) void this.exclusive(() => this.advancePage());
        }
        if (t <= word.end && page.words.has(word.key)) {
          activeKey = word.key;
          this.lastActiveKey = activeKey;
        }
      }
      const focus = sample(this.keyframes, t);
      if (focus) return { focus, activeKey, snap };
    }
    const rest = page.words.get(this.restingKey ?? '') ?? page.firstWord;
    const x = this.opts.mode === 'glide' ? rest.box.r : (rest.box.l + rest.box.r) / 2;
    return { focus: { x, y: rest.box.cy }, snap };
  }

  // ----------------------------------------------------------------------------

  private computeRange(startPage: number, wordKey?: string): PassRange {
    // An A-B loop decides where a pass ends; pages may turn freely until then.
    const loop = this.activeLoop();
    if (loop) return { start: loop.a.page, end: PAGE_COUNT, stopAfter: loop.b.verseKey };
    // "To end of surah" means the surah being started: the given word's, else the
    // page's first word's (the first surah covering the page). It ends after the
    // surah's last ayah, not its last page, which the next surah often shares.
    const chapter = wordKey
      ? this.chapters[Number(wordKey.split(':')[0]) - 1]
      : this.chapters.find((c) => c.pages[0] <= startPage && startPage <= c.pages[1]);
    if (this.opts.range === 'surah' && chapter) {
      return { start: startPage, end: PAGE_COUNT, stopAfter: `${chapter.id}:${chapter.verses_count}` };
    }
    const end = {
      page: startPage,
      pages2: startPage + 1,
      pages5: startPage + 4,
      surah: startPage,
      continuous: PAGE_COUNT,
    }[this.opts.range];
    return { start: startPage, end: Math.min(end, PAGE_COUNT) };
  }

  private async playFrom(pageNumber: number, wordKey?: string): Promise<void> {
    const token = ++this.token;
    this.finished = false;
    this.events.state('loading', 'Loading recitation…');
    try {
      const page = await this.show(pageNumber);
      if (token !== this.token) return;
      const target = (wordKey && page.words.get(wordKey)) || page.firstWord;
      const [chapter, verse, position] = target.key.split(':').map(Number);
      await this.loadChapter(chapter);
      if (token !== this.token) return;

      const data = this.chapterAudio!.data;
      const timing = data.timings.find((v) => v.verse_key === `${chapter}:${verse}`);
      let ms: number;
      this.restingKey = target.key;
      this.rebuildKeyframes();
      if (verse === 1 && position === 1) ms = 0; // include the basmala before ayah 1
      else ms = this.words.find((w) => w.key === target.key)?.start ?? timing?.timestamp_from ?? 0;
      this.audio.currentTime = ms / 1000;
      this.audio.playbackRate = this.opts.rate;
      await this.audio.play();
    } catch (err) {
      if (token === this.token) this.fail(err);
    }
  }

  private async resume(): Promise<void> {
    try {
      await this.audio.play();
    } catch (err) {
      this.fail(err);
    }
  }

  private async loadChapter(chapter: number): Promise<void> {
    const current = this.chapterAudio;
    if (current && current.reciter === this.opts.reciter && current.data.chapter === chapter) return;
    const data = await getChapterAudio(this.opts.reciter, chapter);
    this.chapterAudio = { reciter: this.opts.reciter, data };
    this.segments = flattenSegments(data.timings);
    this.words = this.segments;
    this.keyframes = [];
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        this.audio.removeEventListener('loadedmetadata', done);
        this.audio.removeEventListener('error', failed);
        resolve();
      };
      const failed = () => {
        this.audio.removeEventListener('loadedmetadata', done);
        this.audio.removeEventListener('error', failed);
        reject(new Error(`Could not load audio for surah ${chapter}`));
      };
      this.audio.addEventListener('loadedmetadata', done);
      this.audio.addEventListener('error', failed);
      this.audio.src = data.url;
      this.audio.load();
    });
  }

  /** Attach, measure and reveal a page; keep the following page preloaded and hidden. */
  private async show(pageNumber: number): Promise<MushafPage> {
    this.requestedPage = pageNumber;
    const page = await buildPage(pageNumber, this.opts.script, this.chapters);
    // A newer navigation, script change or font build change superseded this one while it was loading.
    const build = this.opts.script === 'tajweed' ? v4Build() : 'v1';
    if (this.requestedPage !== pageNumber || page.script !== this.opts.script || page.build !== build) return page;
    if (this.page !== page) {
      for (const el of [...this.stage.children]) {
        if (el !== page.el) el.remove();
      }
      if (!page.el.isConnected) this.stage.append(page.el);
      page.el.classList.remove('preload');
      page.measure();
      this.page = page;
      this.snapPending = true;
      this.rebuildKeyframes();
      this.events.page(page);
    }
    if (pageNumber < PAGE_COUNT) {
      buildPage(pageNumber + 1, this.opts.script, this.chapters)
        .then((next) => {
          if (this.page === page) {
            this.nextPage = next;
            // A resting dot (no keyframes) stays resting.
            if (this.keyframes.length > 0) this.rebuildKeyframes();
          }
          if (this.page === page && !next.el.isConnected) {
            next.el.classList.add('preload');
            this.stage.append(next.el);
          }
        })
        .catch(() => {
          // Preloading is opportunistic; the real load will surface errors.
        });
    }
    return page;
  }

  private rebuildKeyframes(): void {
    const page = this.page;
    const audio = this.chapterAudio?.data;
    if (!page || !audio) {
      this.keyframes = [];
      return;
    }
    this.words = retimeHeldStarts(this.segments, (key) => page.words.get(key) ?? this.nextPage?.words.get(key));
    const markers = new Map<string, Box>();
    for (const ref of page.words.values()) {
      if (ref.kind === 'end') markers.set(ref.key.slice(0, ref.key.lastIndexOf(':')), ref.box);
    }
    const basmala = page.basmala.get(audio.chapter);
    const firstStart = this.words[0]?.start ?? 0;
    this.keyframes = buildKeyframes({
      words: this.words,
      timings: audio.timings,
      boxOf: (key) => page.words.get(key)?.box,
      markerOf: (verseKey) => markers.get(verseKey),
      // Most reciters say the basmala before ayah 1; walk the basmala line meanwhile.
      preroll: basmala && firstStart > 800 ? { box: basmala.box, end: firstStart - 150 } : undefined,
      mode: this.opts.mode,
    });
  }

  private async advancePage(): Promise<void> {
    const page = this.page;
    if (!page) return;
    const next = page.page + 1;
    if (next > this.range.end) await this.finishPass();
    else await this.show(next);
  }

  /** Run a playback transition that per-frame checks must not re-trigger meanwhile. */
  private async exclusive(task: () => Promise<void>): Promise<void> {
    this.advancing = true;
    try {
      await task();
    } catch (err) {
      this.fail(err);
    } finally {
      this.advancing = false;
    }
  }

  private activeLoop(): { a: VersePoint; b: VersePoint } | undefined {
    const { a, b } = this.loop;
    return a && b ? { a, b } : undefined;
  }

  /** Ayah under the dot, and whether the dot is (within AT_START_MS of) its start. */
  private position(): (VersePoint & { atStart: boolean }) | undefined {
    const page = this.page;
    if (!page) return undefined;
    if (this.navTarget) return { verseKey: this.navTarget.verseKey, page: this.navTarget.page, atStart: true };
    if (this.chapterAudio && this.keyframes.length > 0) {
      const t = this.now();
      // Seeking to an ayah can land a few ms before its first word; don't let
      // that count as still being in the previous ayah.
      const word = lastStartedWord(this.words, t + SEEK_SLOP_MS);
      // Before the first word (the basmala) counts as ayah 1.
      const verseKey = word ? word.key.slice(0, word.key.lastIndexOf(':')) : `${this.chapterAudio.data.chapter}:1`;
      return { verseKey, page: page.page, atStart: t - this.verseStartMs(verseKey) < AT_START_MS };
    }
    const [c, v, p] = (this.restingKey ?? page.firstWord.key).split(':');
    return { verseKey: `${c}:${v}`, page: page.page, atStart: p === '1' };
  }

  /** Where playback of an ayah begins in the loaded surah's audio (ayah 1 includes the basmala). */
  private verseStartMs(verseKey: string): number {
    if (verseKey.endsWith(':1')) return 0;
    return (
      this.words.find((w) => w.key === `${verseKey}:1`)?.start ??
      this.chapterAudio?.data.timings.find((v) => v.verse_key === verseKey)?.timestamp_from ??
      0
    );
  }

  /** The ayah after (`1`) or before (`-1`) `verseKey`, crossing surahs; undefined past 1:1 or 114:6. */
  private adjacentVerse(verseKey: string, dir: 1 | -1): string | undefined {
    const [c, v] = verseKey.split(':').map(Number);
    if (dir === 1) {
      if (v < this.chapters[c - 1].verses_count) return `${c}:${v + 1}`;
      return c < 114 ? `${c + 1}:1` : undefined;
    }
    if (v > 1) return `${c}:${v - 1}`;
    return c > 1 ? `${c - 1}:${this.chapters[c - 2].verses_count}` : undefined;
  }

  /** Page on which an ayah starts; neighbouring ayat are always on the same or an adjacent page. */
  private async pageOfVerse(verseKey: string, near: number): Promise<number> {
    for (const p of [near, near + 1, near - 1, near + 2, near - 2]) {
      if (p < 1 || p > PAGE_COUNT) continue;
      const page = await buildPage(p, this.opts.script, this.chapters);
      if (page.words.has(`${verseKey}:1`)) return p;
    }
    throw new Error(`Could not find ayah ${verseKey} near page ${near}`);
  }

  private async onChapterEnded(): Promise<void> {
    const current = this.chapterAudio?.data.chapter;
    if (!current || !this.page) return;
    const next = this.chapters[current]; // chapters[] is 0-based, so this is surah current+1
    const stop = this.range.stopAfter;
    const stopsInThisSurah = stop !== undefined && Number(stop.split(':')[0]) <= current;
    if (!next || stopsInThisSurah || next.pages[0] > this.range.end) {
      await this.finishPass();
      return;
    }
    const token = ++this.token;
    this.advancing = true;
    try {
      await this.loadChapter(next.id);
      if (token !== this.token) return;
      if (next.pages[0] > this.page.page) await this.show(next.pages[0]);
      this.rebuildKeyframes();
      this.audio.currentTime = 0;
      await this.audio.play();
    } catch (err) {
      if (token === this.token) this.fail(err);
    } finally {
      this.advancing = false;
    }
  }

  private async finishPass(): Promise<void> {
    this.passesDone++;
    const total = this.opts.repeat;
    if (total === 0 || this.passesDone < total) {
      this.events.pass(this.passesDone + 1, total);
      await this.playFrom(this.sessionStart.page, this.sessionStart.wordKey);
      return;
    }
    this.finished = true;
    this.audio.pause();
    this.passesDone = 0;
    this.keyframes = [];
    this.events.state('finished');
  }

  private fail(err: unknown): void {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      this.events.state('paused', 'Press play to start the audio');
    } else this.events.state('error', message);
  }

  /** Audio clock in ms, extrapolated between the element's coarse currentTime updates. */
  private now(): number {
    const ct = this.audio.currentTime * 1000;
    const perf = performance.now();
    if (ct !== this.lastCt) {
      this.lastCt = ct;
      this.lastPerf = perf;
      return ct;
    }
    if (this.audio.paused || this.audio.seeking) return ct;
    return ct + Math.min(perf - this.lastPerf, 300) * this.audio.playbackRate;
  }
}
