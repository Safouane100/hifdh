import { type Chapter, PAGE_COUNT, wordOrder } from './api';
import type { Engine, VersePoint } from './engine';
import { Listener } from './listener';
import { type MushafPage, buildPage } from './mushaf';
import { type WordStatus, align, normalize, stripOpenings, tokenize } from './recite';

interface Expected {
  key: string;
  page: number;
  plain: string;
  uthmani: string;
}

export interface PracticeEvents {
  /** Status line text; `listening` says whether the microphone is live. */
  status(message: string, listening: boolean): void;
  /** Words just judged as skipped or said differently. */
  mistake(kind: 'missed' | 'wrong', words: string[]): void;
  /** Practice ended on its own because listening became impossible. */
  stopped(reason: string): void;
}

// Load the next page once the reciter is this close to the end of what's loaded.
const LOOKAHEAD_WORDS = 30;

const orderOfKey = (key: string) => {
  const [c, v, p] = key.split(':').map(Number);
  return wordOrder(c, v, p);
};

/**
 * Recitation practice: the reciter recites from memory, the page follows their
 * voice, words not yet recited stay hidden, and skipped or different words are
 * revealed and reported.
 *
 * Statuses come in two layers. What the recogniser has settled on ("final")
 * is committed and never changes; what it is still revising ("interim") only
 * reveals words tentatively, so a mistake is only reported once it is certain
 * the recogniser heard it.
 */
export class Practice {
  active = false;
  private readonly listener: Listener;
  private expected: Expected[] = [];
  private indexOf = new Map<string, number>();
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

  constructor(
    private readonly engine: Engine,
    private readonly chapters: Chapter[],
    private readonly events: PracticeEvents,
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
  }

  get listening(): boolean {
    return this.listener.listening;
  }

  /**
   * Begin reciting from the start of ayah `from`; stop after ayah `until` if
   * given. Call it straight from the click / key handler: the microphone is
   * opened before anything is awaited, as some browsers require.
   */
  async start(from: VersePoint, until?: string): Promise<void> {
    this.reset();
    this.active = true;
    this.until = until;
    this.endOrder = until ? orderOfKey(`${until}:999`) : Infinity;
    this.engine.audio.pause();
    this.listener.start();
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
    if (this.listener.listening) {
      this.listener.stop();
      this.events.status('Paused — press Space to keep reciting', false);
    } else {
      this.listener.start();
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
    for (const i of [...this.hinted]) if (i >= at) this.hinted.delete(i);
    this.cursor = this.shown = this.base = at;
    this.finished = false;
    this.listener.restart();
    if (!this.listener.listening) this.listener.start();
    this.events.status(`Listening — recite from ${this.label(this.expected[at].key)}`, true);
    await this.follow();
  }

  /** Reveal the next word for someone who is stuck. */
  hint(): string | undefined {
    const next = this.expected[this.shown];
    if (!this.active || !next) return undefined;
    this.hinted.add(this.shown);
    this.paint();
    return next.uthmani;
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
    this.active = false;
    this.finished = false;
    this.silent = false;
    this.expected = [];
    this.indexOf.clear();
    this.committed.clear();
    this.tentative.clear();
    this.hinted.clear();
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
      this.indexOf.set(ref.key, this.expected.length);
      this.expected.push({ key: ref.key, page: pageNumber, plain: normalize(ref.plain), uthmani: ref.uthmani });
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
    this.listener.stop();
    const counts = { missed: 0, wrong: 0 };
    for (const status of this.committed.values()) if (status !== 'ok') counts[status]++;
    const mistakes = counts.missed + counts.wrong;
    const parts = [
      mistakes === 0
        ? 'no mistakes heard'
        : `${mistakes} possible mistake${mistakes === 1 ? '' : 's'} (${counts.missed} skipped, ${counts.wrong} different)`,
    ];
    if (this.hinted.size) parts.push(`${this.hinted.size} hint${this.hinted.size === 1 ? '' : 's'}`);
    this.events.status(`Finished: ${parts.join(', ')}. Press P to recite again, Esc to leave.`, false);
  }
}
