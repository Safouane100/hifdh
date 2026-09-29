// Thin wrapper over the browser's Web Speech API in Arabic. Chrome and Edge
// send the audio to their speech service; Safari uses Apple's. Firefox has no
// implementation. Recognition sessions end on their own after silence or about
// a minute, so the listener transparently starts a new one while active; each
// new session's transcript starts empty.

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative;
}
interface RecognitionEvent {
  readonly results: { readonly length: number; [index: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
  onsoundstart: (() => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

// Chrome and Safari have long exposed only the prefixed constructor (newer
// Chrome has both). TypeScript's DOM types don't declare it, so it is looked up
// by name and given the minimal shape this module uses.
function findRecognition(): RecognitionCtor | undefined {
  for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
    if (name in window) {
      const ctor: unknown = Reflect.get(window, name);
      if (typeof ctor === 'function') return ctor as RecognitionCtor;
    }
  }
  return undefined;
}
const Ctor = findRecognition();

// Brave exposes the API but ships without the speech service behind it, so
// every session fails at once.
const IS_BRAVE = 'brave' in navigator;

export const SPEECH_SUPPORTED = Ctor !== undefined && !IS_BRAVE;
export const SPEECH_UNSUPPORTED_REASON = IS_BRAVE
  ? 'Brave does not include a speech-recognition service. Use Google Chrome, Microsoft Edge or Safari to recite.'
  : 'This browser has no speech recognition. Use Google Chrome, Microsoft Edge or Safari to recite.';

/** What the microphone side is doing, for the status line. */
export type Hearing = 'listening' | 'sound' | 'silence';

export interface ListenerEvents {
  /** A new recognition session began; its transcript starts empty. */
  session(): void;
  /** Transcript of the current session so far: settled text, and text still being revised. */
  transcript(final: string, interim: string): void;
  hearing(state: Hearing): void;
  /** Recognition cannot continue; `message` says why and what to do. */
  fatal(message: string): void;
}

const FATAL: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow the microphone for this site and press P again.',
  'service-not-allowed':
    'Speech recognition is turned off for this browser. In Safari, turn on Siri or Dictation in System Settings; otherwise use Google Chrome or Microsoft Edge.',
  'audio-capture': 'No microphone could be opened. Check it is connected and not in use by another app.',
  'language-not-supported': 'This browser cannot recognise Arabic speech. Use Google Chrome, Microsoft Edge or Safari.',
  network:
    'The speech-recognition service could not be reached. Google Chrome and Microsoft Edge send speech to their online service; other Chromium browsers (Brave, Arc, Vivaldi, Opera…) usually lack it. Use Chrome, Edge or Safari, and check the connection.',
};

// A session that ends this soon without hearing anything did not really run.
const QUICK_END_MS = 2000;
// After this many such sessions in a row, stop instead of flashing the mic on and off.
const MAX_QUICK_ENDS = 3;

export class Listener {
  private rec?: Recognition;
  private active = false;
  /** Session we aborted ourselves; its end is expected, not a failure. */
  private aborted?: Recognition;
  private quickEnds = 0;
  private retryTimer = 0;

  constructor(private readonly events: ListenerEvents) {}

  get listening(): boolean {
    return this.active;
  }

  /** Call from the click / key handler: some browsers only open the microphone during a user gesture. */
  start(): void {
    if (!Ctor || this.active) return;
    this.active = true;
    this.quickEnds = 0;
    this.spawn();
  }

  stop(): void {
    this.active = false;
    clearTimeout(this.retryTimer);
    const rec = this.rec;
    this.rec = undefined;
    rec?.abort();
  }

  /** Throw away the current session's transcript and listen afresh (after a jump). */
  restart(): void {
    if (!this.active) return;
    if (this.rec) {
      // Its end event spawns the next session.
      this.aborted = this.rec;
      this.rec.abort();
    } else {
      clearTimeout(this.retryTimer);
      this.spawn();
    }
  }

  private spawn(): void {
    const rec = new Ctor!();
    rec.lang = 'ar-SA';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const startedAt = performance.now();
    let heardAnything = false;
    let lastError = '';
    rec.onaudiostart = () => rec === this.rec && this.events.hearing('listening');
    rec.onsoundstart = () => {
      heardAnything = true;
      if (rec === this.rec) this.events.hearing('sound');
    };
    rec.onresult = (e) => {
      if (rec !== this.rec) return;
      heardAnything = true;
      this.quickEnds = 0;
      let final = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += ` ${r[0].transcript}`;
        else interim += ` ${r[0].transcript}`;
      }
      this.events.transcript(final, interim);
    };
    rec.onerror = (e) => {
      if (rec !== this.rec) return;
      lastError = e.error;
      if (e.error === 'no-speech') {
        this.events.hearing('silence');
        return;
      }
      const message = FATAL[e.error];
      if (!message) return;
      this.stop();
      this.events.fatal(message);
    };
    rec.onend = () => {
      if (rec !== this.rec) return;
      this.rec = undefined;
      if (!this.active) return;
      if (this.aborted === rec) {
        this.aborted = undefined;
        this.spawn();
        return;
      }
      // Silence timing out is normal; a session dying at once without hearing
      // anything is not, and restarting it immediately just blinks the mic.
      const quick = !heardAnything && lastError !== 'no-speech' && performance.now() - startedAt < QUICK_END_MS;
      this.quickEnds = quick ? this.quickEnds + 1 : 0;
      if (this.quickEnds >= MAX_QUICK_ENDS) {
        this.stop();
        this.events.fatal(
          `Speech recognition keeps stopping right after it starts${lastError ? ` (error: ${lastError})` : ''}. ` +
            'Use Google Chrome, Microsoft Edge or Safari, and make sure no other tab or app is using the microphone.',
        );
        return;
      }
      this.retryTimer = window.setTimeout(() => this.active && this.spawn(), quick ? 500 * this.quickEnds : 0);
    };
    this.rec = rec;
    this.events.session();
    try {
      rec.start();
    } catch (err) {
      this.stop();
      this.events.fatal(`Speech recognition could not start: ${err instanceof Error ? err.message : err}`);
    }
  }
}
