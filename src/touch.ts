// Touch gestures on the mushaf: tap, long-press, sideways swipe, vertical drag,
// two-finger sideways swipe and pinch. Mouse input keeps its own click and
// hover handling in main.ts.

export interface Gestures {
  tap(): void;
  /** A finger held still on (x, y). */
  longPress(x: number, y: number): void;
  /** `1` for a swipe to the left (forward, like the › buttons), `-1` for one to the right. */
  swipe(dir: 1 | -1): void;
  /** Two fingers swiped sideways together; same directions as `swipe`. */
  swipe2(dir: 1 | -1): void;
  /** One finger started moving mostly up or down. */
  dragStart(): void;
  /** Vertical distance the finger has moved since it went down, in px (down is positive). */
  drag(dy: number): void;
  /** The finger lifted; `velocity` is its vertical speed just before, in px/ms (down is positive). */
  dragEnd(velocity: number): void;
  pinchStart(): void;
  /** Distance between the two fingers relative to the start of the pinch. */
  pinch(ratio: number): void;
  pinchEnd(): void;
}

const MOVE_SLOP_PX = 10;
const LONG_PRESS_MS = 500;
const SWIPE_MIN_PX = 50;
const SWIPE_MAX_MS = 800;
// Two fingers down are a pinch once their distance changes by this fraction,
// and a swipe once they have moved this far together without it changing.
const PINCH_MIN_CHANGE = 0.12;
const SWIPE2_MIN_PX = 60;
// The release speed of a drag is measured over its last stretch.
const VELOCITY_WINDOW_MS = 100;

/**
 * What the fingers down are doing: `one` is a single finger that may still turn
 * into a tap, swipe, long-press or drag; `two` is two fingers that may still
 * turn into a pinch or a two-finger swipe; `done` ignores everything until all
 * fingers have lifted (a long-press or two-finger swipe happened, or a third
 * finger came down).
 */
type Mode = 'one' | 'drag' | 'two' | 'pinch' | 'done';

/** Recognise gestures made with fingers (or a pen) on `el`, which needs `touch-action: none`. */
export function bindGestures(el: HTMLElement, on: Gestures): void {
  const fingers = new Map<number, { x: number; y: number }>();
  let mode: Mode = 'done';
  /** The first finger down, and where and when it went down. */
  let primary = -1;
  let start = { x: 0, y: 0, t: 0 };
  let pressTimer = 0;
  /** The first finger's recent vertical positions, for the release speed of a drag. */
  let samples: { t: number; y: number }[] = [];
  /** Finger distance and midpoint when the second finger went down. */
  let twoStart = { spread: 1, x: 0, y: 0 };
  /** Finger distance when the pinch began. */
  let pinchFrom = 1;

  const pair = () => {
    const [a, b] = [...fingers.values()];
    return { spread: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  /** Vertical speed over the last stretch before lifting at (`t`, `y`); 0 if the finger had stopped. */
  const velocity = (t: number, y: number) => {
    const from = samples.find((s) => s.t >= t - VELOCITY_WINDOW_MS);
    return from && t > from.t ? (y - from.y) / (t - from.t) : 0;
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 1) {
      mode = 'one';
      primary = e.pointerId;
      start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      samples = [{ t: e.timeStamp, y: e.clientY }];
      pressTimer = window.setTimeout(() => {
        if (mode !== 'one') return;
        mode = 'done';
        on.longPress(start.x, start.y);
      }, LONG_PRESS_MS);
      return;
    }
    clearTimeout(pressTimer);
    // A drag keeps following its own finger; a pinch keeps using the first two.
    if (mode === 'drag' || mode === 'pinch') return;
    if (fingers.size === 2 && mode === 'one') {
      mode = 'two';
      twoStart = pair();
    } else mode = 'done';
  });

  el.addEventListener('pointermove', (e) => {
    const finger = fingers.get(e.pointerId);
    if (!finger) return;
    finger.x = e.clientX;
    finger.y = e.clientY;
    if (mode === 'pinch') {
      on.pinch(pair().spread / pinchFrom);
      return;
    }
    if (mode === 'two') {
      const now = pair();
      const dx = now.x - twoStart.x;
      const dy = now.y - twoStart.y;
      if (Math.abs(now.spread / twoStart.spread - 1) > PINCH_MIN_CHANGE) {
        mode = 'pinch';
        // From here on, so the zoom doesn't jump by the change it took to tell.
        pinchFrom = now.spread;
        on.pinchStart();
      } else if (Math.abs(dx) >= SWIPE2_MIN_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) {
        mode = 'done';
        on.swipe2(dx < 0 ? 1 : -1);
      }
      return;
    }
    if (e.pointerId !== primary) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (mode === 'one' && Math.hypot(dx, dy) > MOVE_SLOP_PX) {
      clearTimeout(pressTimer);
      // Mostly vertical from the start: a drag. Otherwise it may still be a swipe, decided on lifting.
      if (Math.abs(dy) > Math.abs(dx)) {
        mode = 'drag';
        on.dragStart();
      }
    }
    if (mode === 'drag') {
      samples.push({ t: e.timeStamp, y: e.clientY });
      if (samples.length > 20) samples.shift();
      on.drag(dy);
    }
  });

  const lift = (e: PointerEvent) => {
    if (!fingers.delete(e.pointerId)) return;
    if (mode === 'pinch' && fingers.size < 2) {
      mode = 'done';
      on.pinchEnd();
    } else if (mode === 'drag' && e.pointerId === primary) {
      mode = 'done';
      on.dragEnd(e.type === 'pointercancel' ? 0 : velocity(e.timeStamp, e.clientY));
    } else if (mode === 'two') mode = 'done';
    if (fingers.size > 0) return;
    clearTimeout(pressTimer);
    if (mode !== 'one' || e.type === 'pointercancel') return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > 1.5 * Math.abs(dy) && e.timeStamp - start.t <= SWIPE_MAX_MS) {
      on.swipe(dx < 0 ? 1 : -1);
    } else if (Math.hypot(dx, dy) <= MOVE_SLOP_PX) on.tap();
  };
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointercancel', lift);

  // No emulated mouse events or click after a touch: the tap above replaces the
  // click handler, and the long-press replaces the browser's own menu.
  el.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });
  el.addEventListener('contextmenu', (e) => {
    if (fingers.size > 0) e.preventDefault();
  });
}
