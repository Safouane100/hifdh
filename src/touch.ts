// Touch gestures on the mushaf: tap, long-press, sideways flick, drag in any
// direction, two-finger sideways swipe and pinch. Mouse input keeps its own
// click and hover handling in main.ts.

export interface Gestures {
  tap(): void;
  /** A finger held still on (x, y). */
  longPress(x: number, y: number): void;
  /** A quick sideways flick: `1` to the left (forward, like the › buttons), `-1` to the right. */
  swipe(dir: 1 | -1): void;
  /** Two fingers swiped sideways together; same directions as `swipe`. */
  swipe2(dir: 1 | -1): void;
  /** One finger started moving up or down, or sideways more slowly than a flick. */
  dragStart(): void;
  /** Distance the finger has moved since it went down, in px (right and down are positive). */
  drag(dx: number, dy: number): void;
  /** The finger lifted; `vx`, `vy` are its speed just before, in px/ms (right and down are positive). */
  dragEnd(vx: number, vy: number): void;
  pinchStart(): void;
  /** Distance between the two fingers relative to the start of the pinch. */
  pinch(ratio: number): void;
  pinchEnd(): void;
}

const MOVE_SLOP_PX = 10;
const LONG_PRESS_MS = 500;
const SWIPE_MIN_PX = 50;
const SWIPE_MAX_MS = 800;
// Moving sideways, a flick covers this far within this long of starting to
// move; anything slower is a drag that the page follows.
const FLICK_PX = 40;
const FLICK_MS = 100;
// Two fingers down are a pinch once their distance changes by this fraction,
// and a swipe once they have moved this far together without it changing.
const PINCH_MIN_CHANGE = 0.12;
const SWIPE2_MIN_PX = 60;
// The release speed of a drag is measured over its last stretch.
const VELOCITY_WINDOW_MS = 100;

/**
 * What the fingers down are doing: `one` is a single finger that may still turn
 * into a tap, flick, long-press or drag; `flick` is one moving sideways too fast
 * for a drag, a swipe if it goes far enough; `two` is two fingers that may
 * still turn into a pinch or a two-finger swipe; `done` ignores everything
 * until all fingers have lifted (a long-press or two-finger swipe happened, or
 * a third finger came down).
 */
type Mode = 'one' | 'flick' | 'drag' | 'two' | 'pinch' | 'done';

/** Recognise gestures made with fingers (or a pen) on `el`, which needs `touch-action: none`. */
export function bindGestures(el: HTMLElement, on: Gestures): void {
  const fingers = new Map<number, { x: number; y: number }>();
  let mode: Mode = 'done';
  /** The first finger down, and where and when it went down. */
  let primary = -1;
  let start = { x: 0, y: 0, t: 0 };
  let pressTimer = 0;
  /** The first finger's recent positions, for the release speed of a drag. */
  let samples: { t: number; x: number; y: number }[] = [];
  /** When the first finger started to move, as opposed to resting where it went down; 0 until then. */
  let movedAt = 0;
  /** Finger distance and midpoint when the second finger went down. */
  let twoStart = { spread: 1, x: 0, y: 0 };
  /** Finger distance when the pinch began. */
  let pinchFrom = 1;

  const pair = () => {
    const [a, b] = [...fingers.values()];
    return { spread: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  /** Speed over the last stretch before lifting at `e`; 0 if the finger had stopped. */
  const velocity = (e: PointerEvent) => {
    const from = samples.find((s) => s.t >= e.timeStamp - VELOCITY_WINDOW_MS);
    if (!from || e.timeStamp <= from.t) return { x: 0, y: 0 };
    const dt = e.timeStamp - from.t;
    return { x: (e.clientX - from.x) / dt, y: (e.clientY - from.y) / dt };
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 1) {
      mode = 'one';
      primary = e.pointerId;
      start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      samples = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
      movedAt = 0;
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
    if (mode === 'one' || mode === 'drag') {
      samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      if (samples.length > 20) samples.shift();
    }
    if (mode === 'one') {
      const distance = Math.hypot(dx, dy);
      // Half a frame before the first movement seen, so a pause before a flick doesn't count.
      if (!movedAt && distance > 2) movedAt = e.timeStamp - 8;
      if (distance > MOVE_SLOP_PX) {
        clearTimeout(pressTimer);
        const moving = e.timeStamp - movedAt;
        // Up or down is always a drag. Sideways, a flick steps an ayah and a
        // slower movement drags; until that is clear, nothing moves.
        if (Math.abs(dy) > Math.abs(dx) || moving > FLICK_MS) {
          mode = 'drag';
          on.dragStart();
        } else if (distance >= FLICK_PX) mode = 'flick';
      }
    }
    if (mode === 'drag') on.drag(dx, dy);
  });

  const lift = (e: PointerEvent) => {
    if (!fingers.delete(e.pointerId)) return;
    if (mode === 'pinch' && fingers.size < 2) {
      mode = 'done';
      on.pinchEnd();
    } else if (mode === 'drag' && e.pointerId === primary) {
      mode = 'done';
      const v = e.type === 'pointercancel' ? { x: 0, y: 0 } : velocity(e);
      on.dragEnd(v.x, v.y);
    } else if (mode === 'two') mode = 'done';
    if (fingers.size > 0) return;
    clearTimeout(pressTimer);
    if ((mode !== 'one' && mode !== 'flick') || e.type === 'pointercancel') return;
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
