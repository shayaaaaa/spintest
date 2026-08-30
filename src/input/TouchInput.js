// Pointer Events gesture state machine: unifies touch/mouse. Emits
// high-level gestures via the callbacks object rather than raw events, so
// InputMapper never touches DOM event details.
const HOLD_MS = 250;
const MOVE_TOLERANCE_PX = 8;

export class TouchInput {
  constructor(element, callbacks) {
    this.element = element;
    this.cb = callbacks; // { onTap, onBoxSelectStart, onBoxSelectMove, onBoxSelectEnd, onPan, onPanEnd, onPinch, onPinchEnd }
    this.pointers = new Map(); // pointerId -> {x,y}
    this.mode = 'idle'; // idle | pending | boxSelect | pan | pinch
    this.down = null; // {x,y,time}
    this.lastSingle = null; // for pan delta tracking
    this.pinchStartDist = 0;
    this.pinchLastDist = 0;

    element.style.touchAction = 'none';
    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    element.addEventListener('pointerdown', this._onDown);
    element.addEventListener('pointermove', this._onMove);
    element.addEventListener('pointerup', this._onUp);
    element.addEventListener('pointercancel', this._onUp);
  }

  _localPos(e) {
    const r = this.element.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _onDown(e) {
    this.element.setPointerCapture?.(e.pointerId);
    const pos = this._localPos(e);
    this.pointers.set(e.pointerId, pos);

    if (this.pointers.size === 1) {
      this.mode = 'pending';
      this.down = { ...pos, time: performance.now() };
      // A real timer, not a move-driven check — a hold with zero
      // intervening pointermove events (e.g. a perfectly still finger)
      // must still arm box-select once HOLD_MS elapses.
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => this._onHoldTimeout(e.pointerId), HOLD_MS);
    } else if (this.pointers.size === 2) {
      clearTimeout(this.holdTimer);
      // Entering pinch/two-finger-pan: cancel any single-finger interpretation.
      if (this.mode === 'boxSelect') this.cb.onBoxSelectEnd?.(null);
      if (this.mode === 'pan') this.cb.onPanEnd?.();
      this.mode = 'pinch';
      const pts = [...this.pointers.values()];
      this.pinchStartDist = this.pinchLastDist = dist(pts[0], pts[1]);
      this.pinchLastMid = midpoint(pts[0], pts[1]);
    }
  }

  _onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const pos = this._localPos(e);
    this.pointers.set(e.pointerId, pos);

    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const d = dist(pts[0], pts[1]);
      const mid = midpoint(pts[0], pts[1]);
      if (this.pinchLastDist > 0) {
        const scale = d / this.pinchLastDist;
        this.cb.onPinch?.({ scale, centerX: mid.x, centerY: mid.y });
      }
      // Two-finger drag also pans (midpoint movement), per spec.
      if (this.pinchLastMid) {
        const dx = mid.x - this.pinchLastMid.x, dy = mid.y - this.pinchLastMid.y;
        if (dx || dy) this.cb.onPan?.({ dx, dy });
      }
      this.pinchLastDist = d;
      this.pinchLastMid = mid;
      return;
    }

    if (this.pointers.size !== 1) return;

    if (this.mode === 'pending') {
      const moved = dist(pos, this.down);
      if (moved > MOVE_TOLERANCE_PX) {
        // Moved before the hold timer fired — a plain drag, i.e. pan.
        clearTimeout(this.holdTimer);
        this.mode = 'pan';
        this.lastSingle = pos;
      }
      return;
    }

    if (this.mode === 'pan') {
      const dx = pos.x - this.lastSingle.x, dy = pos.y - this.lastSingle.y;
      this.lastSingle = pos;
      this.cb.onPan?.({ dx, dy });
    } else if (this.mode === 'boxSelect') {
      this.cb.onBoxSelectMove?.({ x: pos.x, y: pos.y });
    }
  }

  _onHoldTimeout(pointerId) {
    if (this.mode !== 'pending' || !this.pointers.has(pointerId)) return;
    this.mode = 'boxSelect';
    this.cb.onBoxSelectStart?.({ x: this.down.x, y: this.down.y });
  }

  _onUp(e) {
    clearTimeout(this.holdTimer);
    this.pointers.delete(e.pointerId);
    this.element.releasePointerCapture?.(e.pointerId);

    if (this.mode === 'pinch') {
      if (this.pointers.size < 2) {
        this.cb.onPinchEnd?.();
        if (this.pointers.size === 1) {
          // Fall back to treating the remaining pointer as a fresh pan-only touch.
          const [pos] = this.pointers.values();
          this.mode = 'pan';
          this.lastSingle = pos;
        } else {
          this.mode = 'idle';
        }
      }
      return;
    }

    if (this.mode === 'pending') {
      this.cb.onTap?.({ x: this.down.x, y: this.down.y });
    } else if (this.mode === 'boxSelect') {
      const pos = this._localPos(e);
      this.cb.onBoxSelectEnd?.({ x: pos.x, y: pos.y });
    } else if (this.mode === 'pan') {
      this.cb.onPanEnd?.();
    }
    this.mode = 'idle';
    this.down = null;
  }
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
