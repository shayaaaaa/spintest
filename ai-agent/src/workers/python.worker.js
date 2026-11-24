// Pyodide (CPython 3.13 in WebAssembly) worker. The runtime and packages live in Hub/runtimes/pyodide and are
// served by the service worker at ./hub/runtimes/pyodide/. Project files are copied in before a run and changed
// files are sent back afterwards.
let py = null;
let base = null;

async function boot(indexURL) {
  if (py) return py;
  base = indexURL;
  const { loadPyodide } = await import(indexURL + 'pyodide.mjs');
  py = await loadPyodide({ indexURL, lockFileURL: indexURL + 'pyodide-lock.json', stdout: () => {}, stderr: () => {}, checkAPIVersion: false });
  await py.runPythonAsync(`
import sys, os, io
os.environ['MPLBACKEND'] = 'Agg'
`);
  return py;
}

function snapshot(dir) {
  const out = new Map();
  const FS = py.FS;
  const walk = (p) => {
    let names; try { names = FS.readdir(p); } catch { return; }
    for (const n of names) {
      if (n === '.' || n === '..' || n === '__pycache__') continue;
      const fp = p + '/' + n;
      const st = FS.stat(fp);
      if (FS.isDir(st.mode)) walk(fp); else out.set(fp, st.mtime.getTime() + ':' + st.size);
    }
  };
  walk(dir);
  return out;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  const reply = (msg) => self.postMessage({ id, ...msg });
  try {
    if (type === 'imports') {
      await boot(e.data.indexURL);
      const finder = py.pyimport('pyodide.code').find_imports;
      const imports = finder(e.data.code).toJs();
      reply({ result: imports });
      return;
    }
    if (type === 'run') {
      const { code, cwd, files, packages, indexURL, argv = [], file } = e.data;
      await boot(indexURL);
      if (packages?.length) await py.loadPackage(packages, { messageCallback: () => {}, errorCallback: () => {}, checkIntegrity: false });
      const FS = py.FS;
      // write project files
      const mk = (p) => { const parts = p.split('/').filter(Boolean); let cur = ''; for (const part of parts) { cur += '/' + part; try { FS.mkdir(cur); } catch {} } };
      mk(cwd);
      for (const [p, data] of files) { mk(p.slice(0, p.lastIndexOf('/'))); FS.writeFile(p, new Uint8Array(data)); }
      const before = snapshot(cwd);
      let buf = '';
      const flush = () => { if (buf) { self.postMessage({ id, stream: buf }); buf = ''; } };
      const timer = setInterval(flush, 100);
      py.setStdout({ batched: (s) => { buf += s + '\n'; } });
      py.setStderr({ batched: (s) => { buf += s + '\n'; } });
      FS.chdir(cwd);
      let result = null, error = null;
      try {
        await py.runPythonAsync(`
import sys
sys.argv = ${JSON.stringify([file || '-c', ...argv])}
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as _plt
    _n = [0]
    def _show(*a, **k):
        _n[0] += 1
        name = f"figure_{_n[0]}.png"
        _plt.savefig(name, dpi=110, bbox_inches='tight')
        print(f"[saved plot to {name}]")
        _plt.close('all')
    _plt.show = _show
except ImportError:
    pass
`);
        const r = await py.runPythonAsync(code, { filename: file || '<stdin>' });
        if (r !== undefined && r !== null) { try { result = String(r); } catch {} if (r?.destroy) r.destroy(); }
      } catch (err) { error = String(err.message || err).split('\n').filter(l => !/^\s+File "\/lib\/python|_pyodide|pyodide\/_base/.test(l)).join('\n'); }
      clearInterval(timer); flush();
      // collect changed files
      const after = snapshot(cwd);
      const changed = [];
      for (const [p, sig] of after) if (before.get(p) !== sig) { const data = FS.readFile(p); changed.push([p, data.buffer]); }
      reply({ result, error, changed });
      return;
    }
    if (type === 'reset') { py = null; reply({ result: true }); return; }
  } catch (err) {
    reply({ error: String(err.message || err) });
  }
};
