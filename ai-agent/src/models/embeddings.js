// Text embeddings for RAG and memory search (on-device ONNX by default).
import { settings } from '../core/settings.js';

export function embedModel() {
  const ref = settings.get().models?.embed || 'onnx:Xenova/all-MiniLM-L6-v2';
  return ref.startsWith('onnx:') ? ref.slice(5) : ref;
}

export async function embed(texts, { onProgress } = {}) {
  const { embedTexts } = await import('./local/tjs.js');
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    out.push(...await embedTexts(embedModel(), texts.slice(i, i + 32).map(t => t.slice(0, 2000)), onProgress));
  }
  return out;
}

export function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return s / (Math.sqrt(na * nb) || 1);
}
