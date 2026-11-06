// Time engine builds on identical workloads (bench_core.mjs) in node, headless
// Chromium (V8) and headless WebKit (JavaScriptCore, the iPhone engine), and check
// that every build's results are identical to the first one's.
//   node engine/bench/browser_bench.mjs [browsers=node,chromium,webkit] [name=path ...]
// A path is an emscripten module (.js, e.g. src/fast_engine.js) or a Rust build
// (.wasm, wrapped by engine/pkg/shim.mjs). Default: c=src/fast_engine.js
// rust=engine/pkg/nw_engine.wasm. Browsers need the sandbox off.
// GAMES=374,108 plays those whole games once per engine instead (core.games), and
// reports each game's total and slowest search.
//
// In the browsers every engine is injected as eval'd source, not loaded as a module:
// in Playwright's WebKit (26.5, 2026-09), any script fetched over the network
// (module or classic, routed or blob:) ran a plain typed-array loop ~44x slower than
// the same code eval'd or inlined.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import * as core from './bench_core.mjs';

const root = new URL('../../', import.meta.url);
const [browserArg = 'node,chromium,webkit', ...engineArgs] = process.argv.slice(2);
const which = browserArg.split(',');
const specs = engineArgs.length ? engineArgs : ['c=src/fast_engine.js', 'rust=engine/pkg/nw_engine.wasm'];
const ENGINES = Object.fromEntries(specs.map(s => {
  const [name, path] = s.split('=');
  return [name, resolve(new URL(root).pathname, path)];
}));
const REPS = 3;
const GAMES = process.env.GAMES?.split(',').map(Number);

// Runs in the page (and in node): each engine plays the same games once.
async function tail(factories, bench, seeds) {
  const out = {};
  for (const [k, make] of Object.entries(factories)) out[k] = bench.games(await make(), seeds);
  return out;
}

function reportTail(where, out) {
  const [first] = Object.keys(out);
  console.log(`\n${where}`);
  for (const [k, games] of Object.entries(out))
    for (const [i, g] of games.entries()) {
      const same = k === first ? '' : g.digest === out[first][i].digest ? 'same moves' : 'MOVES DIFFER';
      console.log(`  ${k.padEnd(8)} seed ${String(g.seed).padStart(5)}: ${String(g.moves).padStart(3)} moves, ` +
        `total ${(g.ms / 1000).toFixed(3).padStart(8)} s, slowest ${g.slowest.toFixed(1).padStart(8)} ms  ${same}`);
    }
}
const run = GAMES ? (f, core) => tail(f, core, GAMES) : (f, core) => bench(f, core, REPS);
const show = GAMES ? reportTail : report;

// Runs in the page (and in node): warm up, then alternate engines per repetition.
async function bench(factories, bench, reps) {
  const engines = {};
  for (const [k, make] of Object.entries(factories)) engines[k] = await make();
  const out = {};
  for (const k of Object.keys(engines)) { bench.searches(engines[k], 1, 1000); bench.rollouts(engines[k], 2, 200); }
  for (let rep = 0; rep < reps; rep++) {
    const order = Object.keys(engines);
    if (rep % 2) order.reverse();
    for (const k of order) {
      const s = bench.searches(engines[k]), r = bench.rollouts(engines[k]);
      const o = out[k] ||= { searchMs: 0, sims: 0, digest: s.digest, rollMs: 0, rollouts: 0, wins: r.wins };
      o.searchMs += s.ms; o.sims += s.sims; o.rollMs += r.ms; o.rollouts += r.rollouts;
      if (o.digest !== s.digest || o.wins !== r.wins) throw new Error(`${k} not deterministic`);
    }
  }
  return out;
}

function report(where, out) {
  const [first, ...rest] = Object.keys(out);
  const base = out[first];
  console.log(`\n${where}`);
  for (const [k, o] of Object.entries(out)) {
    const same = k === first ? '' : o.digest === base.digest && o.wins === base.wins ? `results identical to ${first}` : 'RESULTS DIFFER';
    console.log(`  ${k.padEnd(8)} ${(1000 * o.searchMs / o.sims).toFixed(2).padStart(6)} µs/sim ` +
      `(${(o.searchMs / base.searchMs).toFixed(3)}x ${first} time)  ` +
      `${(o.rollouts / o.rollMs * 1000).toFixed(0).padStart(6)} rollouts/s (${(o.rollMs / base.rollMs).toFixed(3)}x)  ${same}`);
  }
}

const read = path => readFileSync(path, 'utf8');
const shim = read(new URL('engine/pkg/shim.mjs', root));
const unmodule = src => src.replace(/^import .*;$/gm, '').replace(/^export (default )?/gm, '');

if (which.includes('node')) {
  const { moduleFrom } = await import(new URL('engine/pkg/shim.mjs', root).href);
  const factories = {};
  for (const [k, p] of Object.entries(ENGINES))
    factories[k] = p.endsWith('.wasm') ? moduleFrom(async () => readFileSync(p)) : (await import(pathToFileURL(p).href)).default;
  show(`node ${process.version}`, await run(factories, core));
}

// Each engine as a classic-script expression that evaluates to its module factory.
const source = path => path.endsWith('.wasm')
  ? `(() => {const B64 = ${JSON.stringify(readFileSync(path).toString('base64'))};
      ${unmodule(shim.slice(shim.indexOf('export function moduleFrom'), shim.indexOf('export default')))}
      return moduleFrom(async () => Uint8Array.from(atob(B64), ch => ch.charCodeAt(0)));})()`
  : `(() => {${read(path).replace('export default Module;', 'return Module;')
      .replaceAll('import.meta.url', JSON.stringify('http://nw.test/fast_engine.js'))}})()`;
const BENCH_SOURCE = `(() => {${unmodule(read(new URL('bench_core.mjs', import.meta.url)))}\nreturn { searches, rollouts, games };})()`;
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  if (!which.includes(name)) continue;
  const browser = await type.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => console.error(name, e));
  await page.setContent('<!doctype html><title>bench</title>');
  const sources = Object.fromEntries(Object.entries(ENGINES).map(([k, p]) => [k, source(p)]));
  const out = await page.evaluate(async ([sources, benchSource, src, arg]) => {
    const factories = {};
    for (const [k, s] of Object.entries(sources)) factories[k] = (0, eval)(s);
    return (0, eval)(`(${src})`)(factories, (0, eval)(benchSource), arg);
  }, [sources, BENCH_SOURCE, (GAMES ? tail : bench).toString(), GAMES ?? REPS]);
  show(`${name} ${browser.version()}`, out);
  await page.close();
  await browser.close();
}
