// Voice: speech-to-text (system recognizer or on-device Whisper) and text-to-speech (system voices, offline on iOS).
import { settings } from '../core/settings.js';
import { createStore } from '../core/store.js';

export const voiceStore = createStore({ listening: false, speaking: false, level: 0 });

// ---------- Text to speech ----------
export function systemVoices() {
  return (speechSynthesis?.getVoices?.() || []).map(v => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: v.localService }));
}

let currentUtter = null;
export function speak(text, { voice, rate = 1.03, onEnd } = {}) {
  stopSpeaking();
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' code block omitted. ').replace(/[#*_`>|]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
  if (!clean || !('speechSynthesis' in window)) { onEnd?.(); return; }
  const want = voice || settings.get().chat?.voice;
  const voices = speechSynthesis.getVoices();
  // Split into sentences: iOS stops long utterances.
  const parts = clean.match(/[^.!?\n]+[.!?]?/g)?.map(s => s.trim()).filter(Boolean) || [clean];
  voiceStore.set({ speaking: true });
  let i = 0;
  const next = () => {
    if (i >= parts.length) { voiceStore.set({ speaking: false }); currentUtter = null; onEnd?.(); return; }
    const u = new SpeechSynthesisUtterance(parts[i++]);
    const v = voices.find(x => x.voiceURI === want) || voices.find(x => x.lang?.startsWith((navigator.language || 'en').slice(0, 2)) && /enhanced|premium|siri/i.test(x.name)) || voices.find(x => x.default);
    if (v) u.voice = v;
    u.rate = rate;
    u.onend = next; u.onerror = next;
    currentUtter = u;
    speechSynthesis.speak(u);
  };
  next();
}
export function stopSpeaking() { try { speechSynthesis.cancel(); } catch {} currentUtter = null; voiceStore.set({ speaking: false }); }

// ---------- Recording ----------
export async function recordAudio({ onLevel, maxMs = 120000, silenceMs = 1800, signal } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  return new Promise((resolve, reject) => {
    let spoke = false, lastLoud = performance.now();
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      if (rec.state !== 'recording') return;
      an.getFloatTimeDomainData(buf);
      let rms = 0; for (const x of buf) rms += x * x; rms = Math.sqrt(rms / buf.length);
      onLevel?.(rms); voiceStore.set({ level: rms });
      if (rms > 0.02) { spoke = true; lastLoud = performance.now(); }
      if (spoke && performance.now() - lastLoud > silenceMs) stop();
      requestAnimationFrame(tick);
    };
    const stop = () => { if (rec.state === 'recording') rec.stop(); };
    const timer = setTimeout(stop, maxMs);
    signal?.addEventListener('abort', stop);
    rec.onstop = async () => {
      clearTimeout(timer);
      stream.getTracks().forEach(t => t.stop());
      voiceStore.set({ listening: false, level: 0 });
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/mp4' });
        const ab = await blob.arrayBuffer();
        const decoded = await ctx.decodeAudioData(ab);
        // Resample to 16 kHz mono for Whisper.
        const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
        const s = off.createBufferSource(); s.buffer = decoded; s.connect(off.destination); s.start();
        const out = await off.startRendering();
        ctx.close();
        resolve({ samples: out.getChannelData(0), blob, duration: decoded.duration });
      } catch (e) { ctx.close(); reject(e); }
    };
    rec.start(250);
    voiceStore.set({ listening: true });
    tick();
    resolve.stop = stop;
  });
}

// ---------- Speech to text ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const hasSystemSTT = () => !!SR;

export function systemListen({ lang, onPartial, signal } = {}) {
  return new Promise((resolve, reject) => {
    const r = new SR();
    r.lang = lang || navigator.language || 'en-US';
    r.interimResults = true; r.continuous = false;
    let final = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
      }
      onPartial?.(final + interim);
    };
    r.onerror = (e) => { voiceStore.set({ listening: false }); e.error === 'no-speech' || e.error === 'aborted' ? resolve(final) : reject(new Error('Speech recognition: ' + e.error)); };
    r.onend = () => { voiceStore.set({ listening: false }); resolve(final); };
    signal?.addEventListener('abort', () => r.stop());
    voiceStore.set({ listening: true });
    r.start();
  });
}

// Listens and returns text, using the configured engine: "system" or an on-device Whisper repo ("onnx:<repo>").
export async function listen({ onPartial, signal } = {}) {
  const pref = settings.get().models?.stt || 'system';
  if ((pref === 'system' && SR) || (!navigator.onLine && SR && pref === 'system')) return systemListen({ onPartial, signal });
  const repo = pref.startsWith('onnx:') ? pref.slice(5) : 'onnx-community/whisper-base';
  const audio = await recordAudio({ signal });
  onPartial?.('Transcribing…');
  const { transcribe } = await import('./local/tjs.js');
  return transcribe(repo, audio.samples);
}
