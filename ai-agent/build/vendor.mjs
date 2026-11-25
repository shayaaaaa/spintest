// Bundles third-party libraries into ../vendor as self-contained ES modules so the app runs offline with no build step.
// Run: cd ai-agent/build && npm install --ignore-scripts && node vendor.mjs
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nm = path.join(here, 'node_modules');
const out = path.join(here, '..', 'vendor');
const tmp = path.join(here, '.tmp');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });

const entry = (name, code) => { const f = path.join(tmp, name + '.entry.js'); fs.writeFileSync(f, code); return f; };
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.copyFileSync(path.join(nm, from), path.join(out, to)); };

// Stubs Node built-ins that some browser builds reference behind feature checks.
const nodeStubs = {
  name: 'node-stubs',
  setup(b) {
    b.onResolve({ filter: /^(fs|path|stream|crypto|os|url|util|zlib|http|https|child_process|worker_threads|perf_hooks|module)$/ }, a => ({ path: a.path, namespace: 'stub' }));
    b.onResolve({ filter: /^node:/ }, a => ({ path: a.path, namespace: 'stub' }));
    b.onResolve({ filter: /^buffer$/ }, () => ({ path: path.join(nm, 'buffer/index.js') }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

async function bundle(name, code, opts = {}) {
  await esbuild.build({
    entryPoints: [entry(name, code)], bundle: true, format: 'esm', minify: true, outfile: path.join(out, name + '.mjs'),
    target: ['safari17', 'chrome120'], legalComments: 'none', nodePaths: [nm], absWorkingDir: here,
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' }, logLevel: 'warning', plugins: [nodeStubs], ...opts,
  });
  console.log('bundled', name, (fs.statSync(path.join(out, name + '.mjs')).size / 1024).toFixed(0) + ' KB');
}

// UI: Preact + hooks + htm
await bundle('preact', `
import { h, render, Component, Fragment, createContext, createRef, toChildArray, cloneElement } from 'preact';
export { h, render, Component, Fragment, createContext, createRef, toChildArray, cloneElement };
export * from 'preact/hooks';
import htm from 'htm';
export const html = htm.bind(h);
`);

// Code editor: CodeMirror 6 with the languages the Code tab supports, plus merge view for diffs
await bundle('codemirror', `
export * from '@codemirror/state';
export * from '@codemirror/view';
export * from '@codemirror/commands';
export * from '@codemirror/language';
export * from '@codemirror/search';
export * from '@codemirror/autocomplete';
export * from '@codemirror/lint';
export { MergeView, unifiedMergeView, acceptChunk, rejectChunk, getChunks } from '@codemirror/merge';
export { javascript } from '@codemirror/lang-javascript';
export { python } from '@codemirror/lang-python';
export { html as htmlLang } from '@codemirror/lang-html';
export { css } from '@codemirror/lang-css';
export { json } from '@codemirror/lang-json';
export { markdown } from '@codemirror/lang-markdown';
export { cpp } from '@codemirror/lang-cpp';
export { rust } from '@codemirror/lang-rust';
export { java } from '@codemirror/lang-java';
export { sql } from '@codemirror/lang-sql';
export { xml } from '@codemirror/lang-xml';
export { yaml } from '@codemirror/lang-yaml';
export { tags } from '@lezer/highlight';
`);

// Markdown rendering: marked + highlight.js + DOMPurify
await bundle('markdown', `
export { Marked, marked } from 'marked';
import hljs from 'highlight.js/lib/common';
export { hljs };
import DOMPurify from 'dompurify';
export { DOMPurify };
`);

// KaTeX (math in chat). Fonts/CSS copied below.
await bundle('katex', `import katex from 'katex'; export default katex; export const renderToString = katex.renderToString;`);
fs.mkdirSync(path.join(out, 'katex', 'fonts'), { recursive: true });
copy('katex/dist/katex.min.css', 'katex/katex.min.css');
for (const f of fs.readdirSync(path.join(nm, 'katex/dist/fonts'))) if (f.endsWith('.woff2')) copy('katex/dist/fonts/' + f, 'katex/fonts/' + f);

// Office documents: create/read docx, xlsx, pptx, pdf, zip
await bundle('office', `
export * as docx from 'docx';
export * as XLSX from 'xlsx';
export { default as PptxGenJS } from 'pptxgenjs';
export * as PDFLib from 'pdf-lib';
export { default as JSZip } from 'jszip';
export { default as mammoth } from 'mammoth/mammoth.browser.js';
`, { platform: 'browser', mainFields: ['browser', 'module', 'main'] });

// PDF reading
copy('pdfjs-dist/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs');
copy('pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs');

// Terminal emulator
await bundle('xterm', `export { Terminal } from '@xterm/xterm'; export { FitAddon } from '@xterm/addon-fit';`);
copy('@xterm/xterm/css/xterm.css', 'xterm.css');

// WebLLM, patched so the app can pass its own artifact cache (reads model files straight from the Hub in OPFS,
// so models are stored once, in Hub/models, instead of being duplicated into Cache Storage).
{
  const src = path.join(nm, '@mlc-ai/web-llm/lib/index.js');
  let code = fs.readFileSync(src, 'utf8');
  const needle = 'function getCacheOptions(appConfig) {\n    const options = {\n        cacheType: getCacheBackend(appConfig),\n    };';
  if (!code.includes(needle)) throw new Error('web-llm patch point not found');
  code = code.replace(needle, needle + '\n    if (appConfig.artifactCache !== undefined) { options.artifactCache = appConfig.artifactCache; }\n    else if (appConfig.useHubCache && globalThis.__aiAgentArtifactCache) { options.artifactCache = globalThis.__aiAgentArtifactCache; }');
  const patched = path.join(tmp, 'web-llm.patched.js');
  fs.writeFileSync(patched, code);
  await bundle('web-llm', `export * from ${JSON.stringify(patched)};`);
}

// Anthropic SDK (cloud models; used with dangerouslyAllowBrowser and the user's own key, stored only on the device)
await bundle('anthropic', `export { default as Anthropic } from '@anthropic-ai/sdk';`, { mainFields: ['browser', 'module', 'main'], conditions: ['browser', 'import'] });

// wllama (llama.cpp in WebAssembly, runs any GGUF on the CPU)
await bundle('wllama', `export * from '@wllama/wllama';`);
copy('@wllama/wllama/esm/wasm/wllama.wasm', 'wllama/wllama.wasm');
// Safari lacks JSPI/Memory64, so it uses the compat build (still WebGPU-accelerated).
copy('@wllama/wllama-compat/wasm/wllama.js', 'wllama/compat/wllama.js');
copy('@wllama/wllama-compat/wasm/wllama.wasm', 'wllama/compat/wllama.wasm');

// transformers.js (ONNX Runtime Web): embeddings, Whisper, TTS, vision. onnxruntime wasm files are loaded from vendor/ort.
await bundle('transformers', `export * from '@huggingface/transformers';`, {
  alias: {},
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser', 'import'],
  external: [],
});
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) copy('@huggingface/transformers/dist/' + f, 'ort/' + f);

// git (isomorphic-git + its fetch-based HTTP client) for the shell's git command
fs.writeFileSync(path.join(tmp, 'buffer-shim.js'), `import { Buffer } from ${JSON.stringify(path.join(nm, 'buffer/index.js'))}; export { Buffer };`);
await bundle('git', `export * as git from 'isomorphic-git'; export { default as http } from 'isomorphic-git/http/web';`, { mainFields: ['browser', 'module', 'main'], conditions: ['browser', 'import'], inject: [path.join(tmp, 'buffer-shim.js')] });

// v86 (x86 emulator for the Linux VM)
copy('v86/build/libv86.mjs', 'v86/libv86.mjs');
copy('v86/build/v86.wasm', 'v86/v86.wasm');
// BIOS images are not in the npm package; fetch them from the v86 repository once.
for (const f of ['seabios.bin', 'vgabios.bin']) {
  const dst = path.join(out, 'v86', f);
  if (fs.existsSync(dst)) continue;
  const r = await fetch(`https://github.com/copy/v86/raw/master/bios/${f}`);
  if (!r.ok) throw new Error(`BIOS download failed: ${f} ${r.status}`);
  fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('vendor done');
