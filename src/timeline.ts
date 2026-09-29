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

export interface KeyframeSources {
  words: TimedWord[];
  timings: VerseTiming[];
  boxOf: (wordKey: string) => Box | undefined;
  /** Ayah-number ornament for a verse, if it is on the page. */
  markerOf: (verseKey: string) => Box | undefined;
  /** Basmala recited before the first ayah (audio from t=0 to `end`). */
  preroll?: { box: Box; end: number };
  mode: TrackingMode;
}

// While the reciter breathes between ayat the focus rests on the ayah number,
// arriving shortly after the ayah ends and leaving shortly before the next starts.
const MARKER_TRAVEL_MS = 180;
const MIN_PAUSE_FOR_MARKER_MS = 2 * MARKER_TRAVEL_MS;
// Reciters often run straight from the last word of a line into the first word
// of the next, which would make the page jump a full line-width instantly. The
// return sweep always gets at least this long, eating into the next word; the
// focus catches up with the voice before that word ends.
const LINE_RETURN_MS = 260;

export function buildKeyframes(src: KeyframeSources): Keyframe[] {
  const kfs: Keyframe[] = [];
  const glide = src.mode === 'glide';
  const startX = (box: Box) => (glide ? box.r : (box.l + box.r) / 2);
  const endX = (box: Box) => (glide ? box.l : (box.l + box.r) / 2);
  const span = (box: Box, start: number, end: number) => {
    kfs.push({ t: start, x: startX(box), y: box.cy });
    kfs.push({ t: end, x: endX(box), y: box.cy });
  };

  if (src.preroll && src.preroll.end > 0) span(src.preroll.box, 0, src.preroll.end);

  const lastEndByVerse = new Map<string, number>();
  let prev: { box: Box; end: number } | undefined;
  for (const w of src.words) {
    const box = src.boxOf(w.key);
    if (!box) continue;
    const newLine = prev !== undefined && prev.box.cy !== box.cy;
    if (newLine && w.start - prev!.end < LINE_RETURN_MS) {
      const arrive = Math.min(prev!.end + LINE_RETURN_MS, w.end);
      const f = (arrive - w.start) / (w.end - w.start);
      kfs.push({ t: arrive, x: startX(box) + (endX(box) - startX(box)) * f, y: box.cy });
      kfs.push({ t: w.end, x: endX(box), y: box.cy });
    } else {
      span(box, w.start, w.end);
    }
    prev = { box, end: w.end };
    const verseKey = w.key.slice(0, w.key.lastIndexOf(':'));
    lastEndByVerse.set(verseKey, Math.max(lastEndByVerse.get(verseKey) ?? 0, w.end));
  }

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
    const x = (marker.l + marker.r) / 2;
    kfs.push({ t: lastEnd + MARKER_TRAVEL_MS, x, y: marker.cy });
    kfs.push({ t: nextStart - MARKER_TRAVEL_MS, x, y: marker.cy });
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
