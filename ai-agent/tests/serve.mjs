// Static server that behaves like GitHub Pages (no special headers), serving the repo root so the app lives at
// http://localhost:PORT/ai-agent/. Usage: node tests/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.bin': 'application/octet-stream', '.md': 'text/markdown' };

export function start(p = port) {
  const server = http.createServer((req, res) => {
    let u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(root, u);
    if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
    try { if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); } catch {}
    fs.stat(f, (err, st) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const headers = { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' };
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(f).pipe(res);
    });
  });
  return new Promise(r => server.listen(p, () => r(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start().then(() => console.log(`serving ${root} on http://localhost:${port}/ai-agent/`));
