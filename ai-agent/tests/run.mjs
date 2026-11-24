// Runs the test suites one after another (each starts its own server and browser).
//   node tests/run.mjs            fast suites (smoke, kernels, model gradients, git)
//   node tests/run.mjs --all      plus the slow ones that download real models (models, agent, forge-train, linux)
//   node tests/run.mjs smoke agent   only the named suites
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAST = [['smoke', []], ['forge-kernels', []], ['forge-model', []], ['runtimes', ['--only=git']]];
const SLOW = [['models', []], ['agent', []], ['forge-train', []], ['runtimes', ['--only=linux']]];
const args = process.argv.slice(2);
const named = args.filter(a => !a.startsWith('--'));
const suites = named.length ? [...FAST, ...SLOW].filter(([n]) => named.includes(n)) : args.includes('--all') ? [...FAST, ...SLOW] : FAST;

const results = [];
for (const [name, extra] of suites) {
  const t0 = Date.now();
  console.log(`\n=== ${name} ${extra.join(' ')}`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, name + '.mjs'), ...extra], { stdio: 'inherit' });
    p.on('exit', (c) => resolve(c ?? 1));
  });
  results.push([name + (extra.length ? ' ' + extra.join(' ') : ''), code, (Date.now() - t0) / 1000]);
}
console.log('\nSummary');
for (const [n, c, s] of results) console.log(`${c === 0 ? 'pass' : 'FAIL'}  ${n}  (${s.toFixed(0)}s)`);
process.exit(results.some(r => r[1] !== 0) ? 1 : 0);
