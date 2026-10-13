// Touch gestures on the mushaf: tap, long-press, sideways swipe and pinch.
// Mouse input keeps its own click and hover handling in main.ts.

export interface Gestures {
  tap(): void;
  /** A finger held still on (x, y). */
  longPress(x: number, y: number): void;
  /** `1` for a swipe to the left (forward, like the › buttons), `-1` for one to the right. */
  swipe(dir: 1 | -1): void;
  pinchStart(): void;
  /** Distance between the two fingers relative to the start of the pinch. */
  pinch(ratio: number): void;
  pinchEnd(): void;
}

const MOVE_SLOP_PX = 10;
const LONG_PRESS_MS = 500;
const SWIPE_MIN_PX = 50;
const SWIPE_MAX_MS = 800;

/** Recognise gestures made with fingers (or a pen) on `el`, which needs `touch-action: none`. */
export function bindGestures(el: HTMLElement, on: Gestures): void {
  const fingers = new Map<number, { x: number; y: number }>();
  /** Where and when the first finger went down. */
  let start = { x: 0, y: 0, t: 0 };
  let pressTimer = 0;
  /** Finger distance when the pinch began; 0 while not pinching. */
  let pinchFrom = 0;
  /** A long-press or pinch has happened, so lifting the fingers is not also a tap or swipe. */
  let decided = false;

  const spread = () => {
    const [a, b] = [...fingers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    clearTimeout(pressTimer);
    if (fingers.size === 1) {
      decided = false;
      start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      pressTimer = window.setTimeout(() => {
        decided = true;
        on.longPress(start.x, start.y);
      }, LONG_PRESS_MS);
    } else if (fingers.size === 2 && !decided) {
      decided = true;
      pinchFrom = spread();
      on.pinchStart();
    }
  });

  el.addEventListener('pointermove', (e) => {
    const finger = fingers.get(e.pointerId);
    if (!finger) return;
    finger.x = e.clientX;
    finger.y = e.clientY;
    if (pinchFrom > 0 && fingers.size === 2) on.pinch(spread() / pinchFrom);
    else if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_SLOP_PX) clearTimeout(pressTimer);
  });

  const lift = (e: PointerEvent) => {
    if (!fingers.delete(e.pointerId)) return;
    if (pinchFrom > 0 && fingers.size < 2) {
      pinchFrom = 0;
      on.pinchEnd();
    }
    if (fingers.size > 0) return;
    clearTimeout(pressTimer);
    if (decided || e.type === 'pointercancel') return;
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
