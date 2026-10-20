import type { VerseTiming } from './api';
import type { Box } from './mushaf';

export interface Point {
  x: number;
  y: number;
}

export interface Keyframe extends Point {
  t: number;
}

export interface TimedWord {
  /** `${chapter}:${verse}:${position}` */
  key: string;
  start: number;
  end: number;
}

/**
 * - `glide`: within each word the focus point travels from its right edge to its
 *   left edge over the word's duration, so the letter under the dot is (roughly)
 *   the one being pronounced.
 * - `word`: the focus point rests on the centre of each word, then hops.
 */
export type TrackingMode = 'glide' | 'word';

/** A surah's word segments sorted by start time; malformed segments are dropped. */
export function flattenSegments(timings: VerseTiming[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const timing of timings) {
    for (const seg of timing.segments ?? []) {
      if (!Array.isArray(seg) || seg.length !== 3) continue;
      const [position, start, end] = seg;
      if (!Number.isFinite(start) || !(end > start)) continue;
      out.push({ key: `${timing.verse_key}:${position}`, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** What re-timing needs to know about a word on the page (see tajweed.ts `beats`). */
export interface SpokenWord {
  beats: number;
  /** Opens with the held letter of an idghām with ghunnah from the previous word. */
  heldStart: boolean;
}

const isNextWord = (prev: string, next: string) => {
  const p = prev.lastIndexOf(':');
  const n = next.lastIndexOf(':');
  return prev.slice(0, p) === next.slice(0, n) && Number(next.slice(n + 1)) === Number(prev.slice(p + 1)) + 1;
};

/**
 * In an idghām with ghunnah (83:4 أَنَّهُم مَّبْعُوثُونَ) the reciter holds the
 * next word's first letter, drawn green, for two beats. Segment data puts that
 * hold on either side of the word boundary depending on the recording, so with
 * the hold counted in the previous word the focus would sit on the end of the
 * line while the green letter starting the next one is being held. Where the
 * segment boundary is later than the two words' combined time shared by their
 * beats, the boundary moves back to that point.
 */
export function retimeHeldStarts(
  words: TimedWord[],
  spokenOf: (wordKey: string) => SpokenWord | undefined,
): TimedWord[] {
  const out = words.slice();
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const next = out[i];
    if (!isNextWord(prev.key, next.key)) continue;
    const a = spokenOf(prev.key);
    const b = spokenOf(next.key);
    if (!a || !b?.heldStart) continue;
    const split = prev.start + ((next.end - prev.start) * a.beats) / (a.beats + b.beats);
    if (!(split > prev.start && split < prev.end)) continue;
    out[i - 1] = { ...prev, end: split };
    out[i] = { ...next, start: Math.min(next.start, split) };
  }
  return out;
}

export interface KeyframeSources {
  words: TimedWord[];
  timings: VerseTiming[];
  boxOf: (wordKey: string) => Box | undefined;
  /** Ayah-number ornament for a verse, if it is on the page. */
  markerOf: (verseKey: string) => Box | undefined;
  /** Basmala recited before the first ayah (audio from t=0 to `end`). */
  preroll?: { box: Box; end: number };
  mode: TrackingMode;
  /** Motion smoothing time constant (ms): line changes leave this much sooner so the smoothed dot lands on time. */
  lead?: number;
}

// While the reciter breathes between ayat the focus rests on the ayah number,
// arriving shortly after the ayah ends and leaving shortly before the next starts.
const MARKER_TRAVEL_MS = 180;
const MIN_PAUSE_FOR_MARKER_MS = 2 * MARKER_TRAVEL_MS;
// Moving to the next line sweeps the page a full line-width back, which takes
// this long. It is timed to finish as the next line's first word starts, so
// the dot is on its first letter then: through a pause the focus waits at the
// end of the line; when the reciter runs straight on, it leaves before the
// line's last word ends.
const LINE_RETURN_MS = 120;

export function buildKeyframes(src: KeyframeSources): Keyframe[] {
  const kfs: Keyframe[] = [];
  const glide = src.mode === 'glide';
  const startX = (box: Box) => (glide ? box.r : (box.l + box.r) / 2);
  const endX = (box: Box) => (glide ? box.l : (box.l + box.r) / 2);
  /** Glide across a word; returns the keyframe at its end, which leaving for the next line may move earlier. */
  const span = (box: Box, start: number, end: number) => {
    kfs.push({ t: start, x: startX(box), y: box.cy });
    const last = { t: end, x: endX(box), y: box.cy };
    kfs.push(last);
    return last;
  };
  const lead = src.lead ?? 0;

  if (src.preroll && src.preroll.end > 0) span(src.preroll.box, 0, src.preroll.end);

  const lastEndByVerse = new Map<string, number>();
  for (const w of src.words) {
    if (!src.boxOf(w.key)) continue;
    const verseKey = w.key.slice(0, w.key.lastIndexOf(':'));
    lastEndByVerse.set(verseKey, Math.max(lastEndByVerse.get(verseKey) ?? 0, w.end));
  }

  // Ayat whose number the focus rests on while the reciter pauses after them.
  const restsOnMarker = new Set<string>();
  for (let i = 0; i < src.timings.length; i++) {
    const verseKey = src.timings[i].verse_key;
    const lastEnd = lastEndByVerse.get(verseKey);
    const marker = src.markerOf(verseKey);
    if (lastEnd === undefined || !marker) continue;
    const next = src.timings[i + 1];
    const nextStart = next
      ? Math.min(...(next.segments ?? []).filter((s) => s.length === 3).map((s) => s[1]), next.timestamp_from)
      : src.timings[i].timestamp_to;
    if (!(nextStart - lastEnd >= MIN_PAUSE_FOR_MARKER_MS)) continue;
    restsOnMarker.add(verseKey);
    const nextBox = next && src.boxOf(`${next.verse_key}:1`);
    const leave = nextBox && nextBox.cy !== marker.cy ? LINE_RETURN_MS + lead : MARKER_TRAVEL_MS;
    const x = (marker.l + marker.r) / 2;
    kfs.push({ t: lastEnd + MARKER_TRAVEL_MS, x, y: marker.cy });
    kfs.push({ t: nextStart - leave, x, y: marker.cy });
  }

  let prev: { box: Box; start: number; end: number; verseKey: string; last: Keyframe } | undefined;
  for (const w of src.words) {
    const box = src.boxOf(w.key);
    if (!box) continue;
    const verseKey = w.key.slice(0, w.key.lastIndexOf(':'));
    const newLine = prev !== undefined && prev.box.cy !== box.cy;
    let last: Keyframe;
    if (newLine) {
      let arrive = w.start - lead;
      // Coming from the previous ayah's number, which the marker keyframes leave on time.
      const fromMarker = prev!.verseKey !== verseKey && restsOnMarker.has(prev!.verseKey);
      if (!fromMarker) {
        const leave = arrive - LINE_RETURN_MS;
        if (leave >= prev!.end) {
          kfs.push({ t: leave, x: endX(prev!.box), y: prev!.box.cy });
        } else {
          // Running straight on: leave the line's last word before it ends.
          const t = Math.max(prev!.start, leave);
          const f = prev!.end > prev!.start ? (t - prev!.start) / (prev!.end - prev!.start) : 1;
          prev!.last.t = t;
          prev!.last.x = startX(prev!.box) + (endX(prev!.box) - startX(prev!.box)) * f;
          arrive = Math.max(arrive, t + LINE_RETURN_MS);
        }
      }
      kfs.push({ t: arrive, x: startX(box), y: box.cy });
      last = span(box, Math.max(w.start, arrive), w.end);
    } else {
      last = span(box, w.start, w.end);
    }
    prev = { box, start: w.start, end: w.end, verseKey, last };
  }

  return kfs.sort((a, b) => a.t - b.t);
}

/** Index of the last element whose `key(el) <= t`, or -1. */
function lastAtOrBefore<T>(items: T[], t: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]) <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Piecewise-linear focus position at audio time `t` (ms); holds at either end. */
export function sample(kfs: Keyframe[], t: number): Point | undefined {
  if (kfs.length === 0) return undefined;
  const i = lastAtOrBefore(kfs, t, (k) => k.t);
  if (i < 0) return kfs[0];
  if (i === kfs.length - 1) return kfs[i];
  const a = kfs[i];
  const b = kfs[i + 1];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** The word most recently started at time `t` (it may already have ended). */
export function lastStartedWord(words: TimedWord[], t: number): TimedWord | undefined {
  return words[lastAtOrBefore(words, t, (w) => w.start)];
}
