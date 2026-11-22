import { type Chapter, PAGE_COUNT, wordOrder } from './api';
import type { Engine, VersePoint } from './engine';
import { Listener } from './listener';
import { type MushafPage, buildPage } from './mushaf';
import { type WordStatus, align, normalize, stripOpenings, tokenize } from './recite';
import { type CheckerEvent, type Passage, TilawaListener, type WordRef } from './tilawa';

/** Which speech recogniser follows the recitation: the browser's speech service, or Tilawa on the device. */
export type Recogniser = 'browser' | 'tilawa';

interface Expected {
  key: string;
  page: number;
  plain: string;
  uthmani: string;
}

export interface PracticeEvents {
  /** Status line text; `listening` says whether the microphone is live. */
  status(message: string, listening: boolean): void;
  /** Words just judged as skipped or said differently, or a word said that isn't there ("added", at the word given). */
  mistake(kind: 'missed' | 'wrong' | 'added', words: string[]): void;
  /** Practice ended on its own because listening became impossible. */
  stopped(reason: string): void;
}

// Load the next page once the reciter is this close to the end of what's loaded.
const LOOKAHEAD_WORDS = 30;

const orderOfKey = (key: string) => {
  const [c, v, p] = key.split(':').map(Number);
  return wordOrder(c, v, p);
};

/** An Arabic letter: what separates a word from a pause mark like ۖ, which quran.com writes after a space. */
const ARABIC_LETTER = /[\u0621-\u064A\u0671-\u06D3]/;

// With Tilawa, a jump of at least this many words when the tracker picks the
// reciter up again counts as a skip.
const SKIP_MIN_WORDS = 3;

/**
 * Recitation practice: the reciter recites from memory, the page follows their
 * voice, words not yet recited stay hidden, and skipped or different words are
 * revealed and reported.
 *
 * Statuses come in two layers. With the browser's recogniser, what it has
 * settled on ("final") is committed and never changes; what it is still
 * revising ("interim") only reveals words tentatively, so a mistake is only
 * reported once it is certain the recogniser heard it. Tilawa reports where the
 * reciter is and judges mistakes itself, so its verdicts are committed directly.
 */
export class Practice {
  active = false;
  private readonly listener: Listener;
  private readonly tilawa: TilawaListener;
  /** The recogniser this session started with; changing the setting applies from the next one. */
  private usesTilawa = false;
  private expected: Expected[] = [];
  private indexOf = new Map<string, number>();
  /** Where this session began, so "again" starts over from there. */
  private from?: VersePoint;
  private until?: string;
  private endOrder = Infinity;
  /** Next page to append to `expected`, or 0 when everything is loaded. */
  private nextPage = 0;
  private loading?: Promise<void>;
  /** Committed position: first word not yet settled. */
  private cursor = 0;
  /** Displayed position, including words the recogniser is still revising. */
  private shown = 0;
  /** `cursor` when the current recognition session began (its transcript starts there). */
  private base = 0;
  private committed = new Map<number, WordStatus>();
  private tentative = new Map<number, WordStatus>();
  private hinted = new Set<number>();
  private finished = false;
  /** The recogniser reported silence and nothing has been heard since. */
  private silent = false;
  /**
   * Tilawa numbers an ayah's words in Tanzil's text, which splits three words
   * quran.com keeps whole (e.g. إِلْ يَاسِينَ in 37:130), so its word keys
   * (`surah:ayah:n`) map to `expected` here, and `tanzilCount` is how many it
   * has numbered so far in each ayah.
   */
  private tanzilIndex = new Map<string, number>();
  private tanzilCount = new Map<string, number>();
  /** Where each stretch Tilawa followed began, so a skipped passage ends where the reciter picked up again. */
  private resumed = new Set<number>();
  /** The surah's ayat Tilawa is listening for now. */
  private passage?: Passage;
  /** Words said that aren't in the text (Tilawa only). */
  private extra = 0;

  constructor(
    private readonly engine: Engine,
    private readonly chapters: Chapter[],
    private readonly events: PracticeEvents,
    private readonly recogniser: () => Recogniser,
  ) {
    this.listener = new Listener({
      session: () => {
        this.base = this.cursor;
      },
      transcript: (final, interim) => this.onTranscript(final, interim),
      hearing: (state) => {
        if (!this.active || this.finished) return;
        // Once silence was reported, keep saying so until sound actually arrives;
        // each new session's "listening" would otherwise hide the problem.
        if (state === 'silence') this.silent = true;
        else if (state === 'sound') this.silent = false;
        if (this.silent) {
          this.events.status(
            'Not hearing anything. Check the microphone chosen in System Settings › Sound › Input (and in the browser’s site settings).',
            true,
          );
        } else if (state === 'listening') {
          const next = this.expected[this.shown];
          this.events.status(`Listening${next ? ` — recite from ${this.label(next.key)}` : ''}`, true);
        }
      },
      fatal: (message) => {
        this.stop();
        this.events.stopped(message);
      },
    });
    this.tilawa = new TilawaListener({
      status: (message) => this.active && this.events.status(message, true),
      listening: () => {
        if (!this.active || !this.passage) return;
        const { surah, fromAyah } = this.passage;
        this.events.status(`Listening — recite from ${this.label(`${surah}:${fromAyah}`)}`, true);
      },
      position: (word, from) => this.onPosition(word, from),
      checker: (event) => this.onChecker(event),
      fatal: (message) => {
        this.stop();
        this.events.stopped(message);
      },
    });
  }

  get listening(): boolean {
    return this.usesTilawa ? this.tilawa.listening : this.listener.listening;
  }

  /** The stretch has been recited to its end (the summary is showing). */
  get done(): boolean {
    return this.active && this.finished;
  }

  /** Recite the same stretch again from where this session began. Call from a key / click handler. */
  async again(): Promise<void> {
    if (this.from) await this.start(this.from, this.until);
  }

  /**
   * Begin reciting from the start of ayah `from`; stop after ayah `until` if
   * given. Call it straight from the click / key handler: the microphone is
   * opened before anything is awaited, as some browsers require.
   */
  async start(from: VersePoint, until?: string): Promise<void> {
    this.reset();
    this.active = true;
    this.from = from;
    this.until = until;
    this.endOrder = until ? orderOfKey(`${until}:999`) : Infinity;
    this.engine.audio.pause();
    this.usesTilawa = this.recogniser() === 'tilawa';
    if (this.usesTilawa) {
      this.passage = this.passageFrom(from.verseKey);
      this.tilawa.begin(this.passage);
    } else this.listener.start();
    this.events.status('Starting the microphone…', true);
    this.nextPage = from.page;
    await this.appendNextPage(orderOfKey(`${from.verseKey}:1`));
    if (!this.active) return;
    const first = this.expected[0];
    if (!first) return;
    await this.engine.focusWord(first.page, first.key);
    this.paint();
  }

  /** Leave practice mode and show the page normally again. */
  stop(): void {
    this.reset();
    if (this.engine.page) this.clear(this.engine.page);
  }

  /** Pause or resume listening without losing progress. */
  toggleListening(): void {
    if (!this.active || this.finished) return;
    if (this.listening) {
      if (this.usesTilawa) this.tilawa.pause();
      else this.listener.stop();
      this.events.status('Paused — press Space to keep reciting', false);
    } else {
      if (this.usesTilawa) this.tilawa.resume();
      else this.listener.start();
      this.events.status('Listening', true);
    }
  }

  /** Recite again from the start of an ayah (arrow keys, clicking a word). */
  async restartAt(point: VersePoint): Promise<void> {
    const at = this.indexOf.get(`${point.verseKey}:1`);
    if (at === undefined) {
      // Outside what's loaded (e.g. before where practice began): start over there.
      await this.start(point, this.until);
      return;
    }
    for (const map of [this.committed, this.tentative]) for (const i of [...map.keys()]) if (i >= at) map.delete(i);
    for (const set of [this.hinted, this.resumed]) for (const i of [...set]) if (i >= at) set.delete(i);
    this.cursor = this.shown = this.base = at;
    this.finished = false;
    if (this.usesTilawa) {
      this.passage = this.passageFrom(point.verseKey);
      this.tilawa.begin(this.passage);
    } else {
      this.listener.restart();
      if (!this.listener.listening) this.listener.start();
    }
    this.events.status(`Listening — recite from ${this.label(this.expected[at].key)}`, true);
    await this.follow();
  }

  /** Reveal the next hidden word in its place on the page, for someone who is stuck; each further hint reveals the word after. */
  hint(): void {
    if (!this.active) return;
    let next = this.shown;
    while (this.hinted.has(next)) next++;
    if (!this.expected[next]) return;
    this.hinted.add(next);
    this.paint();
  }

  /** Apply hidden / revealed / mistake classes to a page's words. */
  paint(page: MushafPage | undefined = this.engine.page): void {
    if (!page || !this.active) return;
    page.el.classList.add('practicing');
    for (const ref of page.words.values()) {
      if (ref.kind === 'end') continue;
      const i = this.indexOf.get(ref.key);
      // Words outside the practised stretch (before the start, after the loop end) stay visible.
      const status = i === undefined ? undefined : (this.committed.get(i) ?? this.tentative.get(i));
      const said = i === undefined || i < this.shown || status !== undefined;
      ref.el.classList.toggle('said', said);
      ref.el.classList.toggle('rec-missed', status === 'missed');
      ref.el.classList.toggle('rec-wrong', status === 'wrong');
      ref.el.classList.toggle('rec-hint', i !== undefined && !said && this.hinted.has(i));
    }
  }

  // --------------------------------------------------------------------------

  private reset(): void {
    this.listener.stop();
    this.tilawa.stop();
    this.active = false;
    this.finished = false;
    this.silent = false;
    this.expected = [];
    this.indexOf.clear();
    this.tanzilIndex.clear();
    this.tanzilCount.clear();
    this.resumed.clear();
    this.committed.clear();
    this.tentative.clear();
    this.hinted.clear();
    this.extra = 0;
    this.passage = undefined;
    this.cursor = this.shown = this.base = 0;
    this.nextPage = 0;
    this.loading = undefined;
  }

  private clear(page: MushafPage): void {
    page.el.classList.remove('practicing');
    for (const ref of page.words.values()) {
      ref.el.classList.remove('said', 'rec-missed', 'rec-wrong', 'rec-hint');
    }
  }

  private label(key: string): string {
    const [c, v] = key.split(':').map(Number);
    return `${this.chapters[c - 1].name_simple} ${v}`;
  }

  /** From the start of ayah `verseKey` to the end of its surah, or the loop end if that comes first. */
  private passageFrom(verseKey: string): Passage {
    const [surah, fromAyah] = verseKey.split(':').map(Number);
    const [untilSurah, untilAyah] = this.until?.split(':').map(Number) ?? [];
    return { surah, fromAyah, toAyah: untilSurah === surah ? untilAyah : this.chapters[surah - 1].verses_count };
  }

  /** Append the words of `nextPage` (from `fromOrder` on, up to the loop end). */
  private async appendNextPage(fromOrder = 0): Promise<void> {
    const pageNumber = this.nextPage;
    if (!pageNumber) return;
    const page = await buildPage(pageNumber, this.engine.opts.script, this.chapters);
    if (!this.active || this.nextPage !== pageNumber) return;
    const refs = [...page.words.values()]
      .filter((r) => r.kind === 'word' && r.order >= fromOrder && r.order <= this.endOrder)
      .sort((a, b) => a.order - b.order);
    for (const ref of refs) {
      const index = this.expected.length;
      this.indexOf.set(ref.key, index);
      this.expected.push({ key: ref.key, page: pageNumber, plain: normalize(ref.plain), uthmani: ref.uthmani });
      const verseKey = ref.key.slice(0, ref.key.lastIndexOf(':'));
      let n = this.tanzilCount.get(verseKey) ?? 0;
      const parts = ref.uthmani.split(/\s+/).filter((t) => ARABIC_LETTER.test(t)).length || 1;
      for (let k = 0; k < parts; k++) this.tanzilIndex.set(`${verseKey}:${++n}`, index);
      this.tanzilCount.set(verseKey, n);
    }
    const reachedEnd = page.lastOrder >= this.endOrder || pageNumber >= PAGE_COUNT;
    this.nextPage = reachedEnd ? 0 : pageNumber + 1;
  }

  private onTranscript(final: string, interim: string): void {
    if (!this.active || this.finished) return;
    // Show what the recogniser hears, so a microphone problem can be told apart
    // from words not matching.
    const heard = `${final} ${interim}`.trim().split(/\s+/).slice(-6).join(' ');
    if (heard) {
      this.silent = false;
      this.events.status(`Heard: ${heard}`, true);
    }
    const plain = this.expected.map((e) => e.plain);
    // A taʿawwudh or basmala said before starting isn't part of the ayat,
    // except Al-Fatiha's basmala, which is its first ayah.
    const clean = (tokens: string[]) =>
      this.base === 0 && plain[0] !== 'بسم' ? stripOpenings(tokens) : tokens;
    const settled = align(plain, this.base, clean(tokenize(final)));
    const current = align(plain, this.base, clean(tokenize(`${final} ${interim}`)));

    const newMistakes: { missed: string[]; wrong: string[] } = { missed: [], wrong: [] };
    for (const [i, status] of settled.statuses) {
      if (this.committed.has(i)) continue;
      this.committed.set(i, status);
      if (status !== 'ok') newMistakes[status].push(this.expected[i].uthmani);
    }
    this.cursor = Math.max(this.cursor, settled.cursor);
    this.tentative = current.statuses;
    this.shown = Math.max(this.cursor, current.cursor);
    if (newMistakes.missed.length) this.events.mistake('missed', newMistakes.missed);
    if (newMistakes.wrong.length) this.events.mistake('wrong', newMistakes.wrong);
    void this.follow();
  }

  /** Tilawa is sure the reciter just said `word`, following on from `from`: reveal up to it and follow. */
  private onPosition(word: WordRef, from: WordRef): void {
    const passage = this.passage;
    if (!this.active || this.finished || !passage) return;
    // The tracker can lock onto any ayah it hears, even outside the passage
    // (the reciter running on, or repeating an earlier surah); only the passage counts here.
    if (word.surah !== passage.surah || word.ayah < passage.fromAyah || word.ayah > passage.toAyah) return;
    const i = this.tanzilIndex.get(`${word.surah}:${word.ayah}:${word.word}`);
    if (i === undefined || i < this.base) return;
    const start = this.tanzilIndex.get(`${from.surah}:${from.ayah}:${from.word}`);
    if (start !== undefined && start >= this.base) {
      this.resumed.add(start);
      // The tracker picked the reciter up again well past where they were: the
      // words in between were skipped, whether or not Tilawa's checker says so
      // (it often leaves a skipped ayah "uncertain"). Shorter gaps are the
      // tracker's own jitter; single omitted words come from the checker.
      if (start - this.cursor >= SKIP_MIN_WORDS) {
        this.judge(Array.from({ length: start - this.cursor }, (_, k) => this.cursor + k), 'missed');
      }
    }
    this.cursor = this.shown = Math.max(this.cursor, i + 1);
    // The surah's last word, with more to recite after it: a session covers one
    // surah, so listening carries on in a new one for the next.
    const next = this.expected[i + 1];
    const nextSurah = next ? Number(next.key.split(':')[0]) : 0;
    if (nextSurah && nextSurah !== passage.surah) {
      this.passage = this.passageFrom(`${nextSurah}:1`);
      this.tilawa.next(this.passage);
    }
    void this.follow();
  }

  /**
   * Tilawa's verdict on a possible mistake. Confirmed ones count, as it
   * advises, and so does a skipped passage it left uncertain once the reciter
   * has clearly carried on after it: missing a skip is worse than a doubtful flag.
   */
  private onChecker(e: CheckerEvent): void {
    if (!this.active) return;
    const uncertainSkip = e.state === 'uncertain' && e.errorClass === 'skipped_passage';
    if (e.state !== 'confirmed' && !uncertainSkip) return;
    const at = this.tanzilIndex.get(`${e.location.surah}:${e.location.ayah}:${e.location.word}`);
    if (at === undefined) return;
    switch (e.errorClass) {
      case 'wrong_word':
        this.judge([at], 'wrong');
        break;
      case 'omitted_word':
        this.judge([at], 'missed');
        break;
      case 'skipped_passage': {
        // From the first skipped word up to where the reciter picked up again.
        const pickedUp = [...this.resumed].filter((i) => i > at);
        if (uncertainSkip && pickedUp.length === 0) break;
        const end = Math.min(...pickedUp, this.cursor);
        this.judge(Array.from({ length: Math.max(1, end - at) }, (_, k) => at + k), 'missed');
        break;
      }
      case 'added_word':
        this.extra++;
        this.events.mistake('added', [this.expected[at].uthmani]);
        break;
    }
  }

  private judge(indices: number[], status: 'missed' | 'wrong'): void {
    const fresh = indices.filter((i) => !this.committed.has(i));
    if (fresh.length === 0) return;
    for (const i of fresh) this.committed.set(i, status);
    this.events.mistake(status, fresh.map((i) => this.expected[i].uthmani));
    this.paint();
  }

  /** Repaint, move the dot to the next word to recite, load ahead, and detect the end. */
  private async follow(): Promise<void> {
    if (this.nextPage && !this.loading && this.expected.length - this.shown < LOOKAHEAD_WORDS) {
      this.loading = this.appendNextPage().finally(() => {
        this.loading = undefined;
      });
    }
    const next = this.expected[this.shown];
    if (next) {
      await this.engine.focusWord(next.page, next.key);
      this.paint();
      return;
    }
    this.paint();
    if (this.loading) {
      await this.loading;
      await this.follow();
      return;
    }
    if (!this.nextPage && this.cursor >= this.expected.length) this.finish();
  }

  private finish(): void {
    this.finished = true;
    if (this.usesTilawa) {
      // Tilawa decides the last mistakes only once the take ends.
      void this.tilawa.finish().then(() => this.active && this.finished && this.summarise());
    } else {
      this.listener.stop();
      this.summarise();
    }
  }

  private summarise(): void {
    const counts = { missed: 0, wrong: 0 };
    for (const status of this.committed.values()) if (status !== 'ok') counts[status]++;
    const mistakes = counts.missed + counts.wrong + this.extra;
    const extra = this.extra ? `, ${this.extra} extra` : '';
    const parts = [
      mistakes === 0
        ? 'no mistakes heard'
        : `${mistakes} possible mistake${mistakes === 1 ? '' : 's'} (${counts.missed} skipped, ${counts.wrong} different${extra})`,
    ];
    if (this.hinted.size) parts.push(`${this.hinted.size} hint${this.hinted.size === 1 ? '' : 's'}`);
    const start = this.from ? ` from ${this.label(`${this.from.verseKey}:1`)}` : '';
    this.events.status(`Finished: ${parts.join(', ')}. Press P to recite it again${start}, Esc to leave.`, false);
  }
}
