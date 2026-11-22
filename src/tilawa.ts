// Reciting with Tilawa (github.com/yazinsai/tilawa): a speech model that runs on
// the device, follows the recitation word by word and judges memorization
// mistakes itself, instead of the browser's speech service returning text for
// this app to compare. The model (25–68 MB) downloads once and is then kept in
// the browser's cache; the SDK is loaded only when Tilawa is first used.
//
// A Tilawa session is one take over one surah's ayat and can't be restarted,
// while reciting here restarts often (arrow keys, drags, clicked words) and runs
// on across surahs. So this module keeps the microphone open itself and feeds
// whichever session is current, starting a new one for each restart or surah.

import type { CheckerEvent, EngineEvent, TilawaSession, WordRef } from '@tilawa/core';
import type { LoadProgress, Tilawa } from '@tilawa/core/web';

export type { CheckerEvent, WordRef };

/** Ayat of one surah to recite. */
export interface Passage {
  surah: number;
  fromAyah: number;
  toAyah: number;
}

export interface TilawaEvents {
  /** Loading progress, for the status line. */
  status(message: string): void;
  /** A session is running and the microphone is live. */
  listening(): void;
  /**
   * The tracker is sure where the reciter is: `word` is the word most recently
   * recited, and `from` the first word of the stretch it has followed since it
   * last had to find its place (after a skip, where the reciter picked up again).
   */
  position(word: WordRef, from: WordRef): void;
  checker(event: CheckerEvent): void;
  /** Listening became impossible. */
  fatal(message: string): void;
}

export const TILAWA_SUPPORTED =
  typeof WebAssembly === 'object' && typeof AudioWorkletNode === 'function' && Boolean(navigator.mediaDevices?.getUserMedia);

// Copies each block of microphone samples out of the audio thread.
const TAP = `registerProcessor('tap', class extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
});`;

/** One model for the life of the page: loading it is the slow part, sessions are cheap. */
let model: Promise<Tilawa> | undefined;

/** The status line for model loading, or undefined to leave it as it is. */
function describe(p: LoadProgress): string | undefined {
  if (p.stage === 'model') {
    if (p.fromCache) return 'Loading the speech model…';
    const mb = Math.round(p.total / 1e6);
    return `Downloading the speech model (${mb} MB, only this once)… ${Math.round(p.fraction * 100)}%`;
  }
  // The Quran text (5 MB) loads alongside the model; saying so would interrupt the model's progress.
  return p.stage === 'warmup' ? 'Preparing the speech model…' : undefined;
}

// iOS kills a tab that goes over its memory cap, so Tilawa keeps iPhones and
// iPads on its 25 MB "lite" model. Everywhere else this asks for the 68 MB
// "full" model, which Tilawa would otherwise also skip on most phones: in a
// test on al-Afasy's 92:17 with ٱلْأَشْقَى spliced in for ٱلْأَتْقَى, full
// flagged the word and lite reported nothing at all.
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function loadModel(status: (message: string) => void): Promise<Tilawa> {
  model ??= import('@tilawa/core/web').then(({ createTilawa }) =>
    createTilawa({
      tier: IOS ? 'auto' : 'full',
      onProgress: (p) => {
        const message = describe(p);
        if (message) status(message);
      },
    }),
  );
  // A failed load (offline, say) is tried again next time.
  model.catch(() => (model = undefined));
  return model;
}

function explain(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError') return 'Allow the microphone for this site in the browser’s settings, then try again.';
  if (name === 'NotFoundError') return 'No microphone was found.';
  if (name === 'TilawaLoadError' || name === 'ModelIntegrityError') {
    return 'Could not load the speech model. Check the connection and try again.';
  }
  if (name === 'ModelBudgetError') return 'Not enough room on this device to keep the speech model.';
  return `The speech model stopped: ${err instanceof Error ? err.message : String(err)}`;
}

export class TilawaListener {
  private mic?: { ctx: AudioContext; stream: Promise<MediaStream>; tap?: AudioWorkletNode };
  private session?: TilawaSession;
  /** Counts takes; a session from an earlier take reports nothing. */
  private take = 0;
  private paused = false;

  constructor(private readonly events: TilawaEvents) {}

  get listening(): boolean {
    return this.mic !== undefined && !this.paused;
  }

  /**
   * Start a new take over `passage`, dropping the one before. Call it straight
   * from the click / key handler the first time: the microphone is opened
   * before anything is awaited, as iOS requires.
   */
  begin(passage: Passage): void {
    this.paused = false;
    this.mic ??= this.openMic();
    const take = ++this.take;
    this.session?.dispose();
    this.session = undefined;
    void this.startSession(passage, take);
  }

  /** Carry the take on into the next surah: what was heard so far is judged, then listening moves on. */
  next(passage: Passage): void {
    const done = this.session;
    this.session = undefined;
    void done?.end().catch(() => {});
    void this.startSession(passage, this.take);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** The take is over: judge what was heard so far (its last mistakes arrive before this resolves), then close the microphone. */
  async finish(): Promise<void> {
    this.paused = true;
    const session = this.session;
    try {
      await session?.end();
    } catch {
      // Already ended or disposed: nothing more to judge.
    }
    if (this.session === session) this.stop();
  }

  stop(): void {
    this.take++;
    this.session?.dispose();
    this.session = undefined;
    const mic = this.mic;
    this.mic = undefined;
    if (!mic) return;
    if (mic.tap) mic.tap.port.onmessage = null;
    void mic.stream.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
    void mic.ctx.close().catch(() => {});
  }

  // --------------------------------------------------------------------------

  private openMic(): NonNullable<TilawaListener['mic']> {
    // Both before any await: iOS only starts audio created during the tap.
    const ctx = new AudioContext();
    void ctx.resume();
    // Echo cancellation, noise suppression and gain control distort recitation for a phoneme model.
    const stream = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const mic: NonNullable<TilawaListener['mic']> = { ctx, stream };
    void this.connect(mic).catch((err) => {
      if (this.mic !== mic) return;
      this.stop();
      this.events.fatal(explain(err));
    });
    return mic;
  }

  private async connect(mic: NonNullable<TilawaListener['mic']>): Promise<void> {
    const url = URL.createObjectURL(new Blob([TAP], { type: 'application/javascript' }));
    try {
      await mic.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = mic.ctx.createMediaStreamSource(await mic.stream);
    if (this.mic !== mic) return;
    const tap = new AudioWorkletNode(mic.ctx, 'tap');
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const session = this.session;
      if (this.paused || session?.state !== 'active') return;
      // Pushes run one at a time in order; the session resamples to its 16 kHz itself.
      session.pushAudio(e.data, mic.ctx.sampleRate).catch((err: unknown) => {
        if (session !== this.session || (err instanceof Error && err.name === 'SessionEndedError')) return;
        this.stop();
        this.events.fatal(explain(err));
      });
    };
    source.connect(tap);
    // Some browsers only run a worklet that reaches the speakers; a muted gain keeps it silent.
    const mute = mic.ctx.createGain();
    mute.gain.value = 0;
    tap.connect(mute).connect(mic.ctx.destination);
    mic.tap = tap;
  }

  private async startSession(passage: Passage, take: number): Promise<void> {
    let tilawa: Tilawa;
    try {
      tilawa = await loadModel((message) => take === this.take && this.events.status(message));
    } catch (err) {
      if (take !== this.take) return;
      this.stop();
      this.events.fatal(explain(err));
      return;
    }
    if (take !== this.take) return;
    // A mistake is confirmed once the next word starts, rather than after a fixed 2.5 s.
    const session = tilawa.startMemorization(passage, { confirm: { after: 'next-word' } });
    session.subscribe((e: EngineEvent) => {
      if (take !== this.take) return;
      if (e.type === 'position' && e.state === 'locked' && e.observed[0]) {
        this.events.position(e.observed[0].word, e.observed[0].span.start);
      } else if (e.type === 'checker') this.events.checker(e);
    });
    this.session = session;
    this.events.listening();
  }
}
