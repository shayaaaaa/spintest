// Fixed-timestep simulation decoupled from rendering. The sim runs at a
// steady rate regardless of display refresh rate; rendering runs on
// requestAnimationFrame and interpolates between the last two sim states.
const SIM_HZ = 20;
const SIM_STEP_MS = 1000 / SIM_HZ;
const MAX_FRAME_MS = 250; // clamp huge gaps (tab backgrounded, debugger pause)

export class GameLoop {
  constructor({ onTick, onRender }) {
    this.onTick = onTick;
    this.onRender = onRender;
    this.accumulator = 0;
    this.lastTime = 0;
    this.running = false;
    this._raf = this._raf.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this._raf);
  }

  stop() {
    this.running = false;
  }

  _raf(now) {
    if (!this.running) return;
    let frameMs = now - this.lastTime;
    this.lastTime = now;
    if (frameMs > MAX_FRAME_MS) frameMs = MAX_FRAME_MS;

    this.accumulator += frameMs;
    while (this.accumulator >= SIM_STEP_MS) {
      this.onTick(SIM_STEP_MS / 1000);
      this.accumulator -= SIM_STEP_MS;
    }

    const alpha = this.accumulator / SIM_STEP_MS;
    this.onRender(alpha);

    requestAnimationFrame(this._raf);
  }
}

export { SIM_HZ, SIM_STEP_MS };
