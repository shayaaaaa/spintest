// All sounds are synthesized with the Web Audio API, so the game needs no audio files.

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.lastGroan = 0;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this.ctx = new AC();
      this.master = ctx.createGain();
      this.master.gain.value = this.enabled ? 0.9 : 0;
      this.lp = ctx.createBiquadFilter();
      this.lp.type = 'lowpass';
      this.lp.frequency.value = 20000;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.ratio.value = 4;
      this.master.connect(this.lp).connect(this.comp).connect(ctx.destination);
      // outdoor echo bus
      this.echo = ctx.createDelay(1.0);
      this.echo.delayTime.value = 0.32;
      const fb = ctx.createGain(); fb.gain.value = 0.28;
      const ef = ctx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 1400;
      this.echoIn = ctx.createGain(); this.echoIn.gain.value = 0.5;
      this.echoIn.connect(this.echo);
      this.echo.connect(ef).connect(fb).connect(this.echo);
      ef.connect(this.master);
      // white noise buffer
      const len = ctx.sampleRate * 2;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.startAmbience();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // iOS needs a sound started inside the gesture
    try {
      const b = this.ctx.createBuffer(1, 1, 22050);
      const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    } catch (e) { /* ignore */ }
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.05);
  }

  get ok() { return !!this.ctx && this.enabled; }
  get now() { return this.ctx.currentTime; }

  _noise(dur, o = {}) {
    const ctx = this.ctx, t = this.now + (o.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = o.rate || 1;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.f0 || 1000, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    f.Q.value = o.q || 1;
    const g = ctx.createGain();
    const peak = o.gain ?? 0.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = src.connect(f).connect(g);
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = o.pan; node = node.connect(p);
    }
    node.connect(this.master);
    if (o.echo) node.connect(this.echoIn);
    src.start(t, Math.random() * Math.max(0, 1.9 - dur));
    src.stop(t + dur + 0.05);
  }

  _tone(freq, dur, o = {}) {
    const ctx = this.ctx, t = this.now + (o.delay || 0);
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    const g = ctx.createGain();
    const peak = o.gain ?? 0.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; node = node.connect(f); }
    node = node.connect(g);
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = o.pan; node = node.connect(p);
    }
    node.connect(this.master);
    if (o.echo) node.connect(this.echoIn);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  shot(power = 1) {
    if (!this.ok) return;
    this._noise(0.5 + power * 0.15, { type: 'lowpass', f0: 5200, f1: 260, q: 0.7, gain: 0.95, echo: true });
    this._noise(0.09, { type: 'highpass', f0: 2500, q: 0.5, gain: 0.5 });
    this._tone(130 - power * 15, 0.32, { f1: 38, gain: 0.85, type: 'sine', echo: true });
    this._tone(70, 0.5, { f1: 30, gain: 0.5, type: 'triangle' });
  }

  auto(heavy = false) {
    if (!this.ok) return;
    this._noise(heavy ? 0.22 : 0.15, { type: 'lowpass', f0: 4200, f1: 450, q: 0.7, gain: heavy ? 0.55 : 0.42 });
    this._noise(0.035, { type: 'highpass', f0: 3000, gain: 0.22 });
    this._tone(heavy ? 115 : 150, 0.08, { f1: 55, gain: heavy ? 0.4 : 0.28 });
  }

  pistol(heavy = false) {
    if (!this.ok) return;
    this._noise(heavy ? 0.4 : 0.18, { type: 'lowpass', f0: heavy ? 4200 : 5200, f1: 380, q: 0.7, gain: heavy ? 0.75 : 0.5, echo: heavy });
    this._noise(0.045, { type: 'highpass', f0: 2800, gain: 0.32 });
    this._tone(heavy ? 120 : 185, 0.12, { f1: 60, gain: heavy ? 0.5 : 0.3 });
  }

  rocket() {
    if (!this.ok) return;
    this._noise(0.28, { type: 'lowpass', f0: 3200, f1: 300, q: 0.7, gain: 0.7 });
    this._tone(95, 0.45, { f1: 38, gain: 0.6 });
    this._noise(1.1, { type: 'bandpass', f0: 500, f1: 2200, q: 0.9, gain: 0.4, attack: 0.05 });
  }

  click(delay = 0, f = 2600, gain = 0.25) {
    if (!this.ok) return;
    this._noise(0.05, { type: 'bandpass', f0: f, q: 6, gain, delay });
  }

  bolt(t = 0) { this.click(t + 0.12, 1800, 0.35); this.click(t + 0.28, 2600, 0.3); this.click(t + 0.42, 1500, 0.35); }

  reload(dur) {
    if (!this.ok) return;
    this.click(0.05, 1200, 0.3);
    this.click(dur * 0.35, 900, 0.35);
    this.click(dur * 0.62, 2200, 0.35);
    this.click(dur * 0.85, 1700, 0.4);
  }

  dry() { this.click(0, 3200, 0.3); }

  hit(pan = 0) {
    if (!this.ok) return;
    this._noise(0.12, { type: 'lowpass', f0: 900, f1: 200, gain: 0.5, pan });
  }

  headshot() {
    if (!this.ok) return;
    this._noise(0.18, { type: 'bandpass', f0: 700, f1: 180, q: 1.5, gain: 0.7 });
    this._tone(1400, 0.12, { f1: 700, gain: 0.12, type: 'square', lp: 3000 });
  }

  ping() {
    if (!this.ok) return;
    this._tone(2400, 0.4, { f1: 2100, gain: 0.18, type: 'triangle' });
    this._tone(3600, 0.25, { gain: 0.08, type: 'sine' });
  }

  ricochet(pan = 0) {
    if (!this.ok) return;
    this._tone(3000, 0.25, { f1: 900, gain: 0.07, type: 'sawtooth', lp: 4000, pan });
    this._noise(0.08, { type: 'highpass', f0: 1800, gain: 0.2, pan });
  }

  dirt(pan = 0) {
    if (!this.ok) return;
    this._noise(0.15, { type: 'lowpass', f0: 1500, f1: 300, gain: 0.25, pan });
  }

  wood(pan = 0, gain = 0.35) {
    if (!this.ok) return;
    this._noise(0.12, { type: 'bandpass', f0: 520, q: 3, gain, pan });
    this._tone(190, 0.1, { f1: 120, gain: gain * 0.6, type: 'triangle', pan });
  }

  // A soft, breathy moan: a few pure partials (no buzzy sawtooth) pitched where phone
  // speakers can reproduce them, a slow shallow wobble, and filtered breath noise.
  groan(pan = 0, vol = 0.3, pitch = 1) {
    if (!this.ok) return;
    const now = this.now;
    if (now - this.lastGroan < 2.8) return;
    this.lastGroan = now;
    const ctx = this.ctx, t = now;
    const dur = 1.3 + Math.random() * 0.8;
    const f0 = (118 + Math.random() * 34) * pitch;
    const peak = Math.min(0.15, vol * 0.45);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + 0.35);
    env.gain.setValueAtTime(peak, t + dur * 0.55);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const soft = ctx.createBiquadFilter(); soft.type = 'lowpass'; soft.frequency.value = 1600; soft.Q.value = 0.5;
    let out = soft.connect(env);
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; out = out.connect(p); }
    out.connect(this.master);

    const wob = ctx.createOscillator(); wob.frequency.value = 2.2 + Math.random();
    const nodes = [wob];
    for (const [h, a] of [[1, 0.55], [2, 0.4], [3, 0.22], [4, 0.1]]) {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f0 * h * 1.06, t);
      o.frequency.linearRampToValueAtTime(f0 * h, t + dur * 0.3);
      o.frequency.linearRampToValueAtTime(f0 * h * 0.82, t + dur);
      const wg = ctx.createGain(); wg.gain.value = f0 * h * 0.012;
      wob.connect(wg).connect(o.frequency);
      const ag = ctx.createGain(); ag.gain.value = a;
      o.connect(ag).connect(soft);
      nodes.push(o);
    }
    const br = ctx.createBufferSource(); br.buffer = this.noiseBuf;
    const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 750 + Math.random() * 250; bf.Q.value = 0.9;
    const bg = ctx.createGain(); bg.gain.value = 0.28;
    br.connect(bf).connect(bg).connect(soft);
    for (const n of nodes) { n.start(t); n.stop(t + dur + 0.05); }
    br.start(t, Math.random() * 0.5); br.stop(t + dur + 0.05);
  }

  explosion(vol = 1) {
    if (!this.ok) return;
    this._noise(1.6, { type: 'lowpass', f0: 1200, f1: 60, q: 0.6, gain: 0.9 * vol, echo: true });
    this._tone(60, 0.9, { f1: 22, gain: 0.9 * vol, type: 'sine' });
  }

  whistle() {
    if (!this.ok) return;
    this._tone(1800, 0.9, { f1: 500, gain: 0.08, type: 'sine' });
  }

  whoosh(dur) {
    if (!this.ok) return;
    this._noise(dur, { type: 'bandpass', f0: 400, f1: 2400, q: 1.2, gain: 0.35, attack: dur * 0.6 });
    this._tone(180, dur, { f1: 90, gain: 0.08, type: 'sine', attack: dur * 0.5 });
  }

  scream(pan = 0) {
    if (!this.ok) return;
    this._tone(900, 0.7, { f1: 380, gain: 0.12, type: 'sawtooth', lp: 2400, pan });
  }

  chime() {
    if (!this.ok) return;
    this._tone(880, 0.25, { gain: 0.15, type: 'triangle' });
    this._tone(1320, 0.35, { gain: 0.13, type: 'triangle', delay: 0.11 });
  }

  ui() {
    if (!this.ok) return;
    this._tone(620, 0.07, { gain: 0.12, type: 'square', lp: 2200 });
  }

  buy() {
    if (!this.ok) return;
    this._tone(1200, 0.08, { gain: 0.12, type: 'square', lp: 4000 });
    this._tone(1800, 0.18, { gain: 0.12, type: 'square', lp: 4000, delay: 0.07 });
  }

  horn() {
    if (!this.ok) return;
    this._tone(220, 1.2, { gain: 0.16, type: 'sawtooth', lp: 900, attack: 0.15 });
    this._tone(165, 1.2, { gain: 0.12, type: 'sawtooth', lp: 700, attack: 0.15 });
  }

  win() {
    if (!this.ok) return;
    [523, 659, 784, 1046].forEach((f, i) => this._tone(f, 0.5, { gain: 0.14, type: 'triangle', delay: i * 0.13 }));
  }

  lose() {
    if (!this.ok) return;
    [392, 330, 262, 196].forEach((f, i) => this._tone(f, 0.6, { gain: 0.14, type: 'sawtooth', lp: 1200, delay: i * 0.18 }));
  }

  setFocus(on) {
    if (!this.ctx) return;
    this.lp.frequency.setTargetAtTime(on ? 900 : 20000, this.ctx.currentTime, 0.12);
  }

  startAmbience() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
    const g = ctx.createGain(); g.gain.value = 0.05;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08;
    const lg = ctx.createGain(); lg.gain.value = 0.025;
    lfo.connect(lg).connect(g.gain);
    src.connect(f).connect(g).connect(this.master);
    src.start(); lfo.start();
  }
}
