// ============================================================================
// Head-to-head: continuous DUPLICATE-format play against the UCT engine, with the
// AI playing the same seed CONCURRENTLY in a second worker.
//
// Why two workers: engine.worker.ts serves its inbox strictly in order and aborts an
// in-flight search the moment a request queues behind it. If the AI shared your
// worker, every tap you made would truncate its search and silently handicap it —
// which would corrupt the exact comparison this page exists to make. Its own worker =
// its own WASM engine, its own game state, a full uncontested core (your half of the
// app issues ZERO searches, by design), and no way for its dice or its evaluation to
// touch your game.
//
// Why duplicate: unpaired win-rates are dominated by deal quality (see the solver
// memories `sim-vs-real-deal-imbalance` and `hard-set-2026-07-02` — deal + dice, not
// search, decide most games). Comparing "my %" to "its ~94%" across DIFFERENT boards
// is nearly uninformative at small n. Pinning the seed isolates decision quality; the
// tally shows the two W-L records, and per-move scoring (which converges far faster
// than W/L) is the real skill readout.
//
// Honest caveat: mulberry32 draws are consumed serially, so once your move sequence
// diverges from the AI's you pull different coins off the same stream. Duplicate
// bridge (same deal), not dice-for-dice identity — the latter isn't coherent once
// actions differ.
//
// All rendering/animation comes from board.ts; all rules and
// search come from the engine (engine/nw-core) via engine.worker.ts. This file is bookkeeping and
// presentation only.
// ============================================================================
import { Board, ORDER, SPEEDS, sleep, drawThumb } from './board.ts';
import { createReviewer, tierOf, invalidateStaleReview } from './review.ts';
import { LEGACY_RULES_VERSION, RULES_VERSION } from './game-version.ts';
import { aiWinCurve, youWinCurve, type CurvePoint } from './projections.ts';
import { createReplayInspector } from './replay.ts';
import { skillHistory, skillComparison, skillTrend, type SkillGame } from './skill.ts';
import engineWorkerUrl from './engine.worker.ts?worker&url';
import type { Api, Faction, GameView, HistPoint, Label, Move, NodeView, Pip, Reply, Round, SearchResult,
  Side, SweepCheck, Tally } from './types.ts';

// The AI plays at the strength the app's autoplay/live driver uses: 6000-sim floor,
// adaptive up to the worker's 150k ceiling with the visit/value-margin early stop.
const AI_SIMS = 6000;
const WIN_NODES = 24;                     // faction node count that ends the game

// Every id the page looks up is in index.html.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// The deployed release (vite.config.ts puts it in the page), or 'dev' under `vite`.
const RELEASE = document.querySelector<HTMLMetaElement>('meta[name=release]')?.content ?? 'dev';
const board = new Board($('cv'), $('board'));
board.onReplay = (faction, nodes) => renderHeader(faction, nodes);

let state: GameView | null = null;   // authoritative view of YOUR game
let inputLocked = false;
// Read-only hook for the e2e tests (e2e/), which need node positions on the canvas.
(window as any).__nw = { board, state: () => state, locked: () => inputLocked, model: () => M };

// ---- diagnostics: never shown in the UI, only written into the data export, so a
// device-specific failure (e.g. the AI stalling on a phone but not on a desktop)
// can be read offline instead of guessed at. A bounded event ring + counters.
interface ReportedError { src: string; msg: string; n: number; at: string; v: string; trail: string[]; prev?: 1 }
const diag = { started: new Date().toISOString(),
  events: [] as ({ t: number; ev: string } & Record<string, unknown>)[],
  saveFails: 0, lastSaveError: null as string | null,
  aiSearches: 0, aiSims: 0, aiSearchMs: 0, aiSearchMaxMs: 0, errors: [] as ReportedError[] };
function note(ev: string, detail?: object) {
  diag.events.push({ t: Math.round(performance.now()) / 1000, ev, ...detail });
  if (diag.events.length > 400) diag.events.splice(0, 100);
}
document.addEventListener('visibilitychange', () => note(document.visibilityState));
// What the player last touched, for the trail on each error (see reportError).
document.addEventListener('pointerup', (e) => {
  const target = e.target as Element;
  note('tap', { on: target.closest?.('[id]')?.id || target.tagName?.toLowerCase() });
}, true);

// ---- errors, surfaced on screen: a phone has no console, so every failure the
// page can see (uncaught errors, a worker that dies or stops answering, an AI seed
// or review that fails, a save that doesn't fit) lands in `diag.errors`, counted on
// the menu's Errors item, which lists them. Each carries the release that raised
// it. Kept in their own small localStorage key so they survive iOS reloading the
// tab; earlier sessions' entries are marked `prev`. Repeats of the same message
// count up instead of stacking. Each keeps a `trail`: the diagnostics events
// (taps, AI and visibility changes) just before it, timed from page load.
const ERR_KEY = 'nwErrors', ERR_MAX = 60;
try { diag.errors = (JSON.parse(localStorage.getItem(ERR_KEY) || '[]') as ReportedError[]).map(e => ({ ...e, prev: 1 })); }
catch (_) { diag.errors = []; }
function reportError(src: string, msg: unknown) {
  const text = String(msg).slice(0, 600);
  const at = new Date().toISOString();
  const same = diag.errors.find(e => !e.prev && e.src === src && e.msg === text);
  const trail = diag.events.slice(-8).map(({ t, ev, ...d }) =>
    `${t.toFixed(1)}s ${ev} ${Object.entries(d).map(([k, v]) => `${k}=${v}`).join(' ')}`.trim());
  if (same) { same.n++; same.at = at; same.trail = trail; }
  else diag.errors.push({ src, msg: text, n: 1, at, v: RELEASE, trail });
  if (diag.errors.length > ERR_MAX) diag.errors.splice(0, diag.errors.length - ERR_MAX);
  note('error', { src, msg: text });
  try { localStorage.setItem(ERR_KEY, JSON.stringify(diag.errors)); } catch (_) {}
  renderErrors();
}
// Safari's stack omits the message line that V8's starts with; keep both once.
const errMsg = (e: unknown) => {
  if (!(e instanceof Error)) return String(e);
  const st = e.stack || '';
  return st.includes(e.message) ? st : `${e.message}\n${st}`;
};
// A bare "Script error." is the browser hiding an error from a script of another
// origin (a Safari extension, say): the page's own scripts always give details.
window.addEventListener('error', (e) => {
  const where = e.filename ? ` @ ${e.filename.split('/').pop()}:${e.lineno}:${e.colno}` : '';
  reportError('page', e.error instanceof Error ? `${errMsg(e.error)}${where}`
    : `${e.message}${where}${where ? '' : ' (from a script outside the page; the browser hides its details)'}`);
});
window.addEventListener('unhandledrejection', (e) => reportError('page', errMsg(e.reason)));

// ---- offline: sw.js caches the page + engine (see its header; built only). Not an
// app error if it can't register (private modes), so only the export hears about it.
if (import.meta.env.PROD)
  navigator.serviceWorker?.register('sw.js').catch((e) => note('sw', { msg: String(e) }));

// ---- independent engines: yours, the AI's, and (lazily, in review.ts) the review pool's ----
interface Pending { resolve: (r: any) => void; path: string; t: number; vis: number; stalled?: boolean }
interface EngineEntry {
  name: string
  pending: Map<number, Pending>
  beat: { sims: number; at: number } | null
  ping: () => Promise<object | null>
}
const engines: EngineEntry[] = [];   // every worker's in-flight requests, for the export
function makeEngine(name = 'review'): Api {
  // One URL per worker: WebKit shares a script load between workers started together,
  // and the second one is then not controlled by sw.js, so its imports fail offline.
  const url = new URL(engineWorkerUrl, location.href);
  url.searchParams.set('n', String(engines.length));
  const w = new Worker(url, { type: 'module' });
  const pending = new Map<number, Pending>();
  let id = 0;
  const pongs: ((probe: object | null) => void)[] = [];
  // beat: the worker's last finished search chunk; ping: its probe(), answered
  // outside its request queue (null if it doesn't answer) — both for stall reports.
  const entry: EngineEntry = { name, pending, beat: null,
    ping: () => new Promise((resolve) => {
      pongs.push(resolve); w.postMessage({ ping: 1 });
      setTimeout(() => resolve(null), 5000);
    }) };
  engines.push(entry);
  w.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'beat') { entry.beat = { sims: d.sims, at: performance.now() }; return; }
    if (d.type === 'pong') { for (const r of pongs.splice(0)) r(d.probe); return; }
    if (d.type === 'progress') return;             // neither side streams here
    const r = pending.get(d.id);
    if (r) { pending.delete(d.id); r.resolve(d.result); }
  };
  // A worker that fails to load or dies with an uncaught error never answers, and
  // its callers (the AI pump above all) would wait forever without a trace. Answer
  // everything in flight with an ordinary {error} reply instead.
  w.onerror = (e) => {
    const error = `${name} worker: ${e.message || 'failed'}`;
    reportError(name, error);
    for (const r of pending.values()) r.resolve({ error });
    pending.clear();
  };
  return (path, method = 'GET', body) => new Promise((resolve) => {
    const k = ++id; pending.set(k, { resolve, path, t: performance.now(), vis: 0 });
    w.postMessage({ id: k, path, method, body });
  });
}
// A worker that silently stops answering (killed by the OS) raises nothing at all.
// Flag any request with no reply after STALL_S seconds of the page being VISIBLE —
// a suspended phone page isn't stalled, and the slowest legitimate request (an AI
// search at its 150k ceiling) takes seconds, not minutes. The report says where the
// worker stopped: its last search chunk (from beats) and, if it still answers a
// ping, what its queue is doing.
const STALL_S = 120;
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  for (const e of engines) for (const p of e.pending.values()) {
    p.vis += 5;
    if (p.vis >= STALL_S && !p.stalled) {
      p.stalled = true;
      reportStall(e, p);
    }
  }
}, 5000);
async function reportStall(e: EngineEntry, p: Pending) {
  const now = performance.now(), age = (t: number) => ((now - t) / 1000).toFixed(1) + 's';
  const beat = e.beat && e.beat.at > p.t ? e.beat : null;
  const head = `no reply to ${p.path} after ${STALL_S}s visible (${age(p.t)} total)`
    + (beat ? ` · last chunk ${age(beat.at)} ago at ${beat.sims} sims` : ' · no search chunk finished');
  const probe = await e.ping();
  reportError(e.name, head
    + (probe ? ` · worker answers: ${JSON.stringify(probe)}` : ' · worker does not answer a ping'));
}
const api = makeEngine('you');   // your game — never issues a search while you play
const aiApi = makeEngine('ai');  // the AI's background game
const inspectMove = createReplayInspector(api);
// Decision scoring (review.ts): its own worker pool, created on the first review.
const reviewer = createReviewer(makeEngine);

// ============================ model ============================
// One entry per seed. `moves` on each side is the full ordered list of RED decisions
// ({a:[from,to]} attack | {e:1} end turn) — replaying it from the seed is bit-exact,
// which is what makes both the retroactive review and the move inspector possible.
// Your moves also carry `t` (epoch ms when committed) and `ms` (think time, see
// thinkStart); swept moves carry `sw: 1` and no `ms`. `at` is when the seed was dealt.
// `hist` is red power sampled per turn: {t: turn, n: nodes, s: total strength}.
const KEY = 'nwH2H';
let M!: Tally;

const blankSide = (): Side => ({ result: null, turns: 0, red: 0, moves: [], hist: [], review: null });
const blankRound = (seed: number): Round => ({ seed, rules: RULES_VERSION, at: Date.now(), startNodes: null,
  you: blankSide(), ai: blankSide() });
// new_game() seeds mulberry32 with this; keep it in 1..2^31-1 like the app does.
const randSeed = () => Math.floor(Math.random() * 0x7ffffffe) + 1;

// localStorage is the only store and Safari caps it near 5 MB per origin (counted in
// UTF-16, so ~2.5M chars). A finished seed with its review weighs ~15-20 KB, so a
// long-running tally WILL reach the cap — and a setItem that threw used to be
// swallowed here, silently freezing the saved state at whatever last fit: every
// reload then resumed that same stale seed (the "same seeds over and over" bug,
// 2026-09-04). Now the write is kept under a soft cap (and retried on a hard
// quota error) by stripping REPLAY DETAIL from the oldest finished pairs: moves,
// labels, per-turn history and the start board go; the W-L result and the review's
// per-decision gaps (what the tally cards and the skill graph read) stay. A
// trimmed seed just can't be opened in the analysis panel any more.
const SAVE_CAP = 2.0e6;       // chars (~100 seeds of full detail) — headroom under Safari's quota
let trimNoted = false;
let saveFrozen = false;       // set once an imported tally is stored, until the reload
function save() {
  if (saveFrozen) return true;
  for (;;) {
    const js = JSON.stringify(M);
    if (js.length > SAVE_CAP && trimOldest()) continue;
    try { localStorage.setItem(KEY, js); return true; }
    catch (e) {
      if (!trimOldest()) {
        console.warn('tally save failed:', e);
        diag.saveFails++; diag.lastSaveError = `${String(e)} (${js.length} chars)`;
        reportError('save', diag.lastSaveError);
        return false;
      }
    }
  }
}
// Oldest untrimmed pair that is fully finished, not the seed in play, and not being
// scored right now (its reviewer still walks r.you.moves). false when nothing's left.
function trimOldest() {
  const eligible = (r: Round, k: number) => !r.trim && r.you.result && r.ai.result
    && k !== M.idx && !reviewing.has(k);
  let i = M.rounds.findIndex((r, k) => eligible(r, k) && r.you.review && !r.you.review.partial);
  // Unanalyzed games must retain their actions: deleting them strands the
  // queue forever. First shed labels/history; fully trim only after grading.
  if (i < 0) i = M.rounds.findIndex((r, k) => eligible(r, k) && !r.lean);
  if (i < 0) return false;
  const r = M.rounds[i];
  if (r.you.review && !r.you.review.partial) trimRound(r);
  else {
    r.lean = 1;
    r.startNodes = null;
    for (const side of [r.you, r.ai]) {
      side.hist = [];
      side.moves = side.moves.map(({ l, q, ...keep }) => keep as Move);   // actions + timing
    }
  }
  if (!trimNoted) {
    trimNoted = true;
    console.warn(`tally near the storage cap — trimming replay detail from the oldest seeds`);
    note('trim', { i });
  }
  return true;
}
function trimRound(r: Round) {
  const rv = r.you.review, played = r.you.moves;
  r.trim = 1;
  r.startNodes = null;
  for (const side of [r.you, r.ai]) { side.moves = []; side.hist = []; }
  // keep exactly what the skill graph + tier bar read, plus each decision's think
  // time (so time-vs-gap stays analyzable); drop labels/Qs/turns
  r.you.review = (rv && !rv.partial)
    ? { version: rv.version, n: rv.n, nLive: rv.nLive, meanLoss: rv.meanLoss, counts: rv.counts,
        moves: rv.moves.map((m, k) => m && { gap: m.gap, dead: m.dead,
          ...(played[k]?.ms != null && { ms: played[k].ms }) }) }
    : null;
}
function load(): Tally | null {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (m && Array.isArray(m.rounds) && m.rounds.length) {
      m.rounds.forEach(invalidateStaleReview);
      return m;
    }
  } catch (_) {}
  return null;
}
const cur = () => M.rounds[M.idx];

const redStrength = (s: GameView) => s.nodes.reduce((a, n) => a + (n.owner === 'red' ? n.strength : 0), 0);

// Snapshot the two nodes an attack was played into, at the moment it was played. Kept
// on the move itself so BOTH move lists render as colored pips + a direction arrow
// without needing a replay (or a review) first. x/y are what dirArrow needs.
const mkLabel = (s: GameView, from: number, to: number): Label => ({
  f: { owner: s.nodes[from].owner, strength: s.nodes[from].strength, x: s.nodes[from].x, y: s.nodes[from].y },
  t: { owner: s.nodes[to].owner, strength: s.nodes[to].strength, x: s.nodes[to].x, y: s.nodes[to].y },
});

// Red power, one point per turn. Re-sampling the same turn overwrites it, so each
// point is the state after that turn's RED actions — consistent for both sides.
function sampleHist(side: Side, s: GameView) {
  const pt: HistPoint = { t: s.turn, n: s.counts.red, s: redStrength(s) };
  const last = side.hist[side.hist.length - 1];
  if (last && last.t === s.turn) side.hist[side.hist.length - 1] = pt;
  else side.hist.push(pt);
}

// Stamp a finished game's outcome. A forfeit (the menu) is stamped separately.
function recordEnd(side: Side, s: GameView) {
  if (!s.over) return false;
  side.result = s.youWon ? 'won' : 'lost';
  side.turns = s.turn;
  side.red = s.counts.red;
  save();
  return true;
}

// ============================ chrome ============================
function renderHeader(active: Faction = 'red', nodes: NodeView[] | null = null) {
  const h = $('chips');
  h.innerHTML = '';
  if (!state) return;
  const counts = nodes ? Object.fromEntries(ORDER.map(f => [f, 0])) as Record<Faction, number> : state.counts;
  if (nodes) for (const n of nodes) counts[n.owner]++;
  for (const f of ORDER) {
    const c = counts[f];
    const d = document.createElement('div');
    d.className = 'chip ' + f + (f === active ? ' cur' : '') + (c === 0 ? ' dead' : '');
    d.setAttribute('aria-label', `${f}: ${c} nodes${f === active ? ', current turn' : ''}`);
    d.textContent = String(c);
    h.appendChild(d);
  }
}

function stats() {
  let yw = 0, yl = 0, aw = 0, al = 0, both = 0, onlyYou = 0, onlyAI = 0, neither = 0;
  for (const r of M.rounds) {
    if (r.you.result === 'won') yw++; else if (r.you.result === 'lost') yl++;
    if (r.ai.result === 'won') aw++; else if (r.ai.result === 'lost') al++;
    if (!r.you.result || !r.ai.result) continue;
    if (r.you.result === 'won' && r.ai.result === 'won') both++;
    else if (r.you.result === 'won') onlyYou++;
    else if (r.ai.result === 'won') onlyAI++;
    else neither++;
  }
  return { yw, yl, aw, al, both, onlyYou, onlyAI, neither };
}

function renderStrip() {
  if (!M) return;
  $('mgame').textContent = `Seed ${M.idx + 1}`;
  const s = stats();
  $('tally').innerHTML = `You <b>${s.yw}–${s.yl}</b><span class="sep"></span>AI <b>${s.aw}–${s.al}</b><i id="aidot"></i>`;
  paintAiDot(aiBusy);
}

const resize = () => board.resize();
window.addEventListener('resize', resize);
window.addEventListener('resize', () => refreshSkill());
if (window.ResizeObserver) new ResizeObserver(resize).observe($('board'));

// ============================ background AI ============================
// A pump that keeps the AI busy: it plays any dealt seed it hasn't finished,
// forever. It never touches your worker, your game state or your dice.
let aiBusy = false;
const aiErr: Record<number, string> = {};   // seeds the AI could not play this session (transient)

// A pulsing dot beside the AI's score while it plays a seed in the background.
const paintAiDot = (busy: boolean) => $('aidot')?.classList.toggle('on', busy);

// The inspected/just-finished pair, then the newest dealt seed and its backlog.
// Selection happens between complete moves, so history cannot hold up the pair
// the player is waiting for and no search is truncated to change priorities.
function nextAiSeed() {
  const pending = (k: number) => {
    const r = M.rounds[k];
    return r?.startNodes && !r.ai.result && !aiErr[k];
  };
  // Finish the pair being inspected, or just played, before the speculative
  // next game. Recheck after each AI move so older games cannot block it.
  if (seedPanelOn(sdIdx) && pending(sdIdx)) return sdIdx;
  for (const k of [M.idx, M.idx - 1])
    if (pending(k) && M.rounds[k].you.result) return k;
  for (let k = M.rounds.length - 1; k >= 0; k--) {
    if (pending(k)) return k;
  }
  return -1;
}

async function aiPump() {
  if (aiBusy) return;
  aiBusy = true;
  reviewer.setLanes(1);                        // the live game gets the cores
  try {
    for (;;) {
      const i = nextAiSeed();
      if (i < 0) break;
      // One unplayable seed must not wedge the AI forever: before this, a worker
      // error threw out of the pump, and every later call picked the same broken
      // seed again, so the AI never finished another game all session.
      try { await aiPlaySeed(i); }
      catch (e) {
        aiErr[i] = e instanceof Error ? e.message : String(e); console.warn(`AI seed ${i + 1}:`, e);
        reportError('ai', `seed ${i + 1}: ${errMsg(e)}`);
      }
    }
  } finally {
    note('ai-idle');
    aiBusy = false;
    reviewer.setLanes(reviewer.workers);       // idle: background scoring may fan out
    paintAiDot(false);
  }
}

// Every worker reply is checked: an `{error}` view has no counts/nodes, so letting
// one through only turns a clear failure into a TypeError deeper in the pump.
async function aiStep<T extends Reply = GameView>(path: string, method?: string, body?: object): Promise<T> {
  const s = await aiApi<T>(path, method, body);
  if (s.error) throw new Error(s.error);
  return s;
}

async function aiPlaySeed(i: number) {
  const r = M.rounds[i];
  const g = r.ai;
  note('ai-seed', { i, resumeAt: g.moves.length });
  let s = await aiStep('/api/game', 'POST', { seed: r.seed, rules: r.rules ?? LEGACY_RULES_VERSION });
  // Resume saved AI actions using the seed's dice, without repeating searches.
  // This also lets the pump switch seeds between moves without losing work.
  if (!g.moves.length) { g.hist = []; sampleHist(g, s); }
  for (const mv of g.moves) {
    s = mv.e ? await aiStep(`/api/game/${s.id}/end-turn`, 'POST')
      : await aiStep(`/api/game/${s.id}/attack`, 'POST', { from: mv.a[0], to: mv.a[1] });
  }
  // Before the first search: its opening think can take seconds.
  paintAiDot(true);
  for (let guard = 0; guard < 4000 && !s.over; guard++) {
    const t0 = performance.now();
    const res = await aiStep<SearchResult>(`/api/game/${s.id}/search`, 'POST', { sims: AI_SIMS });
    const ms = performance.now() - t0;
    diag.aiSearches++; diag.aiSims += res.sims || 0; diag.aiSearchMs += ms;
    diag.aiSearchMaxMs = Math.max(diag.aiSearchMaxMs, ms);
    const b = res.best;
    const q = res.winexp == null ? null : Math.round(res.winexp * 1e4) / 1e4;   // 4 dp: storage
    if (!b || b.from == null || b.to == null) {
      g.moves.push({ e: 1, q });
      s = await aiStep(`/api/game/${s.id}/end-turn`, 'POST');
    } else {
      g.moves.push({ a: [b.from, b.to], q, l: mkLabel(s, b.from, b.to) });
      s = await aiStep(`/api/game/${s.id}/attack`, 'POST', { from: b.from, to: b.to });
    }
    sampleHist(g, s);
    if (g.moves.length % 4 === 0) save();        // throttled: full-state write per move is wasteful
    if (!s.over && nextAiSeed() !== i) {
      note('ai-switch', { i, moves: g.moves.length });
      save();
      await aiStep(`/api/game/${s.id}`, 'DELETE');
      return;
    }
    await sleep(0);                              // yield so the UI stays smooth
  }
  if (!s.over) throw new Error('AI move limit reached');
  recordEnd(g, s);
  note('ai-done', { i, result: g.result, moves: g.moves.length });
  await aiStep(`/api/game/${s.id}`, 'DELETE');
  save();
  renderStrip();
  refreshSeedPanel(i);                  // an analysis open on this seed fills in now
}

// ============================ your play ============================
// Fully blind: no search is ever issued on your worker while you play. (The opt-in
// sweep-up offer below used to be an exception; it now certifies its mop-up policy
// by playing the policy out, so there is no exception left.)

// Think time per decision, for analysis in the data export (never shown). The clock
// runs from the moment the board is yours to act on (seed dealt, attack resolved,
// bot turns animated) to the tap that commits the move, and only while you can see
// the board: animations, a hidden tab and a full-screen panel (the analysis that
// opens after a loss, results, errors) don't count.
const think = { on: false, acc: 0, since: null as number | null };
function thinkSync() {
  const now = performance.now();
  if (think.since != null) { think.acc += now - think.since; think.since = null; }
  if (think.on && document.visibilityState === 'visible' && !document.querySelector('.ov.show'))
    think.since = now;
}
function thinkStart() { think.on = true; think.acc = 0; think.since = null; thinkSync(); }
document.addEventListener('visibilitychange', thinkSync);
for (const ov of document.querySelectorAll('.ov'))
  new MutationObserver(thinkSync).observe(ov, { attributes: true, attributeFilter: ['class'] });
// Stamp a move as it is committed: wall-clock time + think time, or `sw` if swept.
function timed(mv: Move): Move {
  thinkSync();
  mv.t = Date.now();
  if (sweeping) mv.sw = 1;
  else if (think.on) mv.ms = Math.round(think.acc);
  think.on = false; think.since = null;
  return mv;
}

async function startSeed() {
  const r = cur();
  const res = await api('/api/game', 'POST', { seed: r.seed, rules: r.rules ?? LEGACY_RULES_VERSION });
  r.startNodes = res.nodes.map(n => ({ x: n.x, y: n.y, owner: n.owner, strength: n.strength }));
  r.you.moves = []; r.you.hist = [];
  save();
  adopt(res); resize(); renderStrip();
  sampleHist(r.you, res); save();
  thinkStart();
  aiPump();                                    // the AI starts this seed too, right now
}

function adopt(s: GameView) {
  state = s;
  board.setView(s);
  renderHeader();
  board.draw();
}

// Disable End Turn until the attack or whole-turn animation finishes.
async function replayAnimation(run: () => Promise<void>) {
  $('endturn').classList.add('off');
  try { await run(); }
  finally { $('endturn').classList.remove('off'); }
}

async function yourAttack(from: number, to: number) {
  if (!state) return;
  inputLocked = true; board.abort = false; cancelSweepOffer();
  board.selected = null; board.battle = { from, to }; board.draw();
  cur().you.moves.push(timed({ a: [from, to], l: mkLabel(state, from, to) }));
  const res = await api(`/api/game/${state.id}/attack`, 'POST', { from, to });
  const e = res.log && res.log[0];
  if (e && e.flips && !board.instant) await replayAnimation(() => board.animateBattle(e));
  board.battle = null;
  adopt(res); sampleHist(cur().you, res); save();
  inputLocked = false;
  if (recordEnd(cur().you, res)) await afterYourGame();
  else { thinkStart(); maybeOfferSweep(); }
}

async function yourEndTurn() {
  if (!state || state.over || inputLocked) return;
  inputLocked = true; board.abort = false; cancelSweepOffer();
  board.selected = null; board.draw();
  cur().you.moves.push(timed({ e: 1 }));
  const res = await api(`/api/game/${state.id}/end-turn`, 'POST');
  const { events } = res;
  if (events?.length && !board.instant) await replayAnimation(() => board.animateEndTurn({ events }));
  inputLocked = false;
  adopt(res); sampleHist(cur().you, res); save();
  if (recordEnd(cur().you, res)) { await afterYourGame(); return; }
  thinkStart();
  maybeOfferSweep();
}

async function afterYourGame() {
  const i = M.idx, r = M.rounds[i];
  const lost = r.you.result === 'lost';
  renderStrip();
  const over = $('over'), footer = over.parentElement!;
  over.textContent = r.you.forfeit ? 'Forfeited' : lost ? 'You lost' : 'You won';
  footer.classList.add('over');
  // Start this review even when the backlog pump is waiting on an older game.
  // Worker priority yields at the next complete search, preserving its grades.
  runReview(i).then(scorePump);
  await sleep(lost ? 1600 : 2400);   // a look at the final board
  // straight on to the next seed; the AI catches up in its own time
  M.rounds.push(blankRound(randSeed()));
  M.idx = M.rounds.length - 1;
  save();
  await startSeed();
  footer.classList.remove('over');
  // A loss is the interesting case — open its analysis and start scoring immediately.
  // The next seed is already dealt underneath, so closing drops you straight into it.
  if (lost) openSeed(i);
}

// Input: tap-select-then-tap-target, OR press on a red node and DRAG onto a
// highlighted neighbor (release = attack). A drag that ends on nothing / the
// origin just leaves the node selected, so the tap flow keeps working.
type Point = { x: number; y: number }
// While a pointer is held on a red node.
let drag: { from: number; pid: number; retap?: boolean; at: Point } | null = null;
const cvPt = (ev: PointerEvent): Point => { const b = $('cv').getBoundingClientRect(); return { x: ev.clientX - b.left, y: ev.clientY - b.top }; };
function endDrag() {
  drag = null; board.dragTo = null; board.hoverMove = null;
}
// Generous press: an exact hit wins; a press that misses every node snaps to the
// nearest node it could act on (a red node with attacks, the selected node, or one
// of its targets) within the same slop as a drag release.
function pressNode(p: Point) {
  const hit = board.hitNode(p.x, p.y);
  if (hit) return hit;
  const ids = new Set(board.targetsFor.keys());
  if (board.selected !== null) {
    ids.add(board.selected);
    for (const t of board.targetsFor.get(board.selected) ?? []) ids.add(t);
  }
  return board.nearestOf(p.x, p.y, ids);
}
$('cv').addEventListener('pointerdown', (ev) => {
  if (!M || !state || state.over || inputLocked || sweeping) return;
  const p = cvPt(ev), n = pressNode(p);
  if (!n) { board.selected = null; board.draw(); return; }
  if (board.selected !== null && board.targetsFor.get(board.selected)?.has(n.id)) {
    yourAttack(board.selected, n.id); return;
  }
  if (n.id === board.selected) {
    // second press on the selected node: could be a deselect-tap or the start of a
    // drag — decide on pointerup (moved onto a target = attack, else deselect)
    drag = { from: n.id, pid: ev.pointerId, retap: true, at: p };
    $('cv').setPointerCapture(ev.pointerId);
    return;
  }
  if (n.owner === 'red' && n.strength > 1 && board.targetsFor.has(n.id)) {
    board.selected = n.id;
    drag = { from: n.id, pid: ev.pointerId, at: p };
    $('cv').setPointerCapture(ev.pointerId);
  } else board.selected = null;
  board.draw();
});
// Where a drag from `from` currently points: an exact hit on the origin or a target,
// else the nearest of them within the slop. The origin competes with its targets, so
// an off-center press that snapped onto it doesn't attack a neighbor on release.
function dragNode(p: Point, from: number) {
  const hit = board.hitNode(p.x, p.y), targets = board.targetsFor.get(from);
  if (hit && (hit.id === from || targets?.has(hit.id))) return hit;
  return board.nearestOf(p.x, p.y, new Set([from, ...(targets ?? [])]));
}
// a press that barely moves is a tap, never an attack, wherever it snapped
const dragged = (p: Point, at: Point) => Math.hypot(p.x - at.x, p.y - at.y) > board.layout.r * 0.6;
$('cv').addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.pid) return;
  const p = cvPt(ev), n = dragNode(p, drag.from);
  const tgt = dragged(p, drag.at) && n && n.id !== drag.from ? n : null;
  const moved = !n || n.id !== drag.from;
  if (moved) drag.retap = false;                   // it's a drag now, not a tap
  board.hoverMove = tgt ? { from: drag.from, to: tgt.id } : null;
  board.dragTo = tgt ? null : p;                   // free line to the finger until it snaps to a target
  board.draw();
});
function dragUp(ev: PointerEvent) {
  if (!drag || ev.pointerId !== drag.pid) return;
  const { from, retap, at } = drag;
  const p = cvPt(ev), n = dragNode(p, from);
  const tgt = dragged(p, at) && n && n.id !== from ? n : null;
  endDrag();
  if (tgt && !inputLocked && !sweeping) {          // released on/near a highlighted target
    yourAttack(from, tgt.id); return;
  }
  if (retap && n && n.id === from) board.selected = null;
  board.draw();
}
$('cv').addEventListener('pointerup', dragUp);
for (const ev of ['contextmenu', 'selectstart']) $('cv').addEventListener(ev, (e) => e.preventDefault());
$('cv').addEventListener('pointercancel', (ev) => { if (drag && ev.pointerId === drag.pid) { endDrag(); board.draw(); } });
$('endturn').onclick = () => { if (!sweeping) yourEndTurn(); };
// Animation speed is the bolt next to End Turn: off = fast, on = instant.
let instant = false;
function setInstant(on: boolean) {
  instant = on;
  board.speed = on ? SPEEDS.instant : SPEEDS.fast;
  $('bolt').setAttribute('aria-pressed', String(on));
}
try { setInstant(localStorage.getItem('nwSpeed') === 'instant'); } catch (_) { setInstant(false); }
$('bolt').onclick = () => {
  setInstant(!instant);
  try { localStorage.setItem('nwSpeed', instant ? 'instant' : 'fast'); } catch (_) {}
};

// ============================ sweep-up ============================
// Off-by-default assist (nwSweep toggle): after each of
// your moves the worker certifies the mop-up policy from the engine by PLAYING
// IT OUT SWEEP_TRIALS times on fresh dice; if none of them lose, a banner offers to
// auto-play the rest with it — through yourAttack/yourEndTurn, so swept moves are
// recorded, animated and scored exactly like taps. It re-certifies before every
// swept action (looser bar) and hands the game back if the dice turn.
//
// This replaces a gate that asked the search "does every root move win >99.95%?",
// which was wrong in a way that mattered here: measured over 190 games it fired in
// 188 of them at a median of turn 3 / 10 RED nodes and the mop-ups it authorized
// lost 5.3% of the time (solver/sweep_audit.py) — it was handing LIVE games to a
// greedy policy, and those moves then went into your move list and your decision
// score as if you had chosen them. A certificate of the actual policy also removes
// the "your worker never searches" exception entirely: playouts are not searches,
// so this page's worker now issues ZERO searches while you play, full stop.
const SWEEP_TRIALS = 1000, SWEEP_STEP_TRIALS = 400, SWEEP_STEP_LOSSES = 2;
let sweepOn = false, sweeping = false, sweepDismissed = -1, sweepSeq = 0;
function hideSweep() { $('sweep').classList.remove('show'); }
// A committed move invalidates any in-flight detection (the worker aborts it,
// but its early result must not pop a stale offer for the pre-move position).
function cancelSweepOffer() { ++sweepSeq; hideSweep(); }
function setSweep(on: boolean) {
  sweepOn = on;
  $('mi-sweep').classList.toggle('sel', on);
  try { localStorage.setItem('nwSweep', on ? '1' : '0'); } catch (_) {}
  if (!on) { ++sweepSeq; hideSweep(); }
}
(function loadSweep() {
  let v: string | null = null; try { v = localStorage.getItem('nwSweep'); } catch (_) {}
  sweepOn = v === '1';
  $('mi-sweep').classList.toggle('sel', sweepOn);
})();
$('mi-sweep').onclick = () => setSweep(!sweepOn);

async function maybeOfferSweep() {
  if (!sweepOn || sweeping || !state || state.over) return;
  if (sweepDismissed === M.idx) return;                // dismissed for this seed
  // only offer once RED holds a strict majority of the board (more nodes than every
  // bot combined) — a certified position short of that is still a game worth playing
  // by hand. Over 40 seeds this moved the median offer from 15 to 16 RED nodes.
  const c = state.counts;
  const others = ORDER.reduce((n, f) => f === 'red' ? n : n + c[f], 0);
  if (c.red <= others) return;
  const my = ++sweepSeq, gid = state.id;
  const res = await api<SweepCheck>(`/api/game/${gid}/sweep-check`, 'POST', { trials: SWEEP_TRIALS });
  if (my !== sweepSeq || sweeping || !state || state.id !== gid || state.over) return;
  if (res.ok) $('sweep').classList.add('show');
}
$('sw-x').onclick = () => { sweepDismissed = M ? M.idx : -1; hideSweep(); };
$('sw-go').onclick = () => runSweep();

async function runSweep() {
  if (sweeping || !state || state.over || inputLocked) return;
  hideSweep();
  sweeping = true;
  const gid = state.id;
  try {
    let guard = 400;                     // terminal-or-bust backstop, never hit in a won game
    // afterYourGame deals the next seed inside yourAttack/yourEndTurn, so a
    // changed game id is the loop's "this seed finished" signal.
    while (state && state.id === gid && !state.over && guard--) {
      // Re-certify before committing: the dice keep rolling as the mop-up plays, so
      // "won when you pressed the button" is not the same claim as "still won now".
      const chk = await api<SweepCheck>(`/api/game/${gid}/sweep-check`, 'POST',
        { trials: SWEEP_STEP_TRIALS, maxLosses: SWEEP_STEP_LOSSES });
      if (!chk.ok) break;
      const m = chk.move;                // from the engine — the same policy that was certified
      if (m) await yourAttack(m.from, m.to);
      else await yourEndTurn();
    }
  } finally {
    sweeping = false;
  }
}

// ============================ skill over time ============================
const SKILL_ZOOMS: Record<string, number> = { 10: 10, 100: 100, all: Infinity };
let skillZoom = '100';
try { const z = localStorage.getItem('nwSkillZoom'); if (z && z in SKILL_ZOOMS) skillZoom = z; } catch (_) {}
function setSkillZoom(z: string) {
  skillZoom = z;
  try { localStorage.setItem('nwSkillZoom', z); } catch (_) {}
  refreshSkill();
}

function refreshSkill() {
  if (!$('sk') || !$('ov-res').classList.contains('show')) return;
  document.querySelectorAll<HTMLElement>('#skzoom button').forEach(el => {
    el.classList.toggle('sel', el.dataset.z === skillZoom);
    el.setAttribute('aria-pressed', String(el.dataset.z === skillZoom));
  });
  const history = skillHistory(M.rounds, reviewing, reviewErr);
  $('skill').hidden = !history.some(g => g.value != null);
  if ($('skill').hidden) return;
  const c = skillComparison(history), both = 'now' in c ? c : null;
  const d = skillTrend(history, SKILL_ZOOMS[skillZoom]);
  drawSkill($<HTMLCanvasElement>('sk'), d);
  const legend = $('sklegend');
  legend.dataset.state = c.state;
  const now = history.findLast(g => g.value != null)?.value;
  legend.innerHTML = both
    ? `<span>Avg loss/decision · ${both.earlier.toFixed(1)} → <b>${both.now.toFixed(1)}</b> pts</span>`
    : now != null ? `<span>Avg loss/decision · <b>${now.toFixed(1)}</b> pts</span>` : '';
  legend.setAttribute('aria-label', both
    ? `Average decision cost: previous ${both.size} games ${both.earlier.toFixed(1)}, latest ${both.size} games ${both.now.toFixed(1)} points`
    : 'Average decision cost');
}

// Games with lost replay data are omitted. Pending reviews keep their place
// until scored, so old scores do not slide forward into the latest game.
type TrendPoint = SkillGame & { trend: number | null }
let skHit: { W: number; padL: number; padR: number; games: TrendPoint[] } | null = null;
function skTap(ev: MouseEvent) {
  if (!skHit) return;
  const frac = (ev.offsetX - skHit.padL) / (skHit.W - skHit.padL - skHit.padR);
  const i = Math.round(Math.min(1, Math.max(0, frac)) * (skHit.games.length - 1));
  const game = skHit.games[i];
  if (!game?.canReplay) return;
  closeRes();
  openSeed(game.ri, { fromResults: true, sel: game.k });
}

function drawSkill(cv: HTMLCanvasElement, games: TrendPoint[]) {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width)), H = Math.max(1, Math.round(rect.height));
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const padL = 33, padR = 12, padT = 12, padB = 26;
  skHit = games.length ? { W, padL, padR, games } : null;
  const values = games.flatMap(p => [p.value, p.trend].filter(v => v != null));
  g.font = '10px -apple-system, sans-serif';
  if (!values.length) {
    g.fillStyle = '#8fcfb8'; g.textAlign = 'center';
    g.fillText('—', W / 2, H / 2);
    return;
  }
  const yMax = Math.max(10, Math.ceil(Math.max(...values) / 10) * 10);
  const xOf = (i: number) => games.length < 2 ? (padL + W - padR) / 2 : padL + i / (games.length - 1) * (W - padL - padR);
  const yOf = (v: number) => padT + (1 - v / yMax) * (H - padT - padB);
  for (const v of [0, yMax / 2, yMax]) {
    g.fillStyle = '#8fcfb8'; g.textAlign = 'right'; g.fillText(String(v), padL - 7, yOf(v) + 3);
    g.strokeStyle = 'rgba(255,255,255,.09)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, yOf(v)); g.lineTo(W - padR, yOf(v)); g.stroke();
  }
  g.fillStyle = '#8fcfb8'; g.textAlign = 'left'; g.fillText(`Game #${games[0].ri + 1}`, padL, H - 6);
  if (games.length > 1) { g.textAlign = 'right'; g.fillText(`#${games[games.length - 1].ri + 1}`, W - padR, H - 6); }
  // Quiet game averages give context without burying the trend in move dots.
  games.forEach((p, i) => {
    if (p.value == null) return;
    g.fillStyle = 'rgba(95,208,214,.3)'; g.beginPath(); g.arc(xOf(i), yOf(p.value), 2, 0, Math.PI * 2); g.fill();
  });
  let drawing = false;
  g.beginPath();
  games.forEach((p, i) => {
    if (p.trend == null) { drawing = false; return; }
    if (drawing) g.lineTo(xOf(i), yOf(p.trend)); else g.moveTo(xOf(i), yOf(p.trend));
    drawing = true;
  });
  g.strokeStyle = YOU_COL; g.lineWidth = 2.5; g.lineJoin = 'round'; g.stroke();
  games.forEach((p, i) => {
    if (p.trend == null || (i < games.length - 1 && games[i + 1].trend != null)) return;
    g.fillStyle = YOU_COL; g.beginPath(); g.arc(xOf(i), yOf(p.trend), 3, 0, Math.PI * 2); g.fill();
  });
}

// ============================ tally ============================
function showResults() {
  const s = stats();
  const yn = s.yw + s.yl, an = s.aw + s.al;
  const paired = s.both + s.onlyYou + s.onlyAI + s.neither;

  $('res-title').textContent = `Tally · ${paired} pair${paired === 1 ? '' : 's'} complete`;

  const anySkill = M.rounds.some(r => r.you.result);
  const skillHtml = !anySkill ? '' : `
    <section id="skill" hidden>
    <div class="h3row"><h3>Skill over time</h3>
      <div class="zchips" id="skzoom" aria-label="Games shown">
        <button data-z="10" aria-label="Last 10 games">10</button><button data-z="100" aria-label="Last 100 games">100</button><button data-z="all" aria-label="All games">All</button>
      </div></div>
    <canvas class="pg" id="sk" role="img" aria-label="Decision cost by game. Lower means better decisions."></canvas>
    <div class="glegend" id="sklegend"></div>
    </section>`;

  $('res-body').innerHTML = `
    <div id="score">
      <div class="sc ${s.yw > s.aw ? 'lead' : ''}"><div class="who">You</div>
        <div class="n">${s.yw}–${s.yl}</div>
        <div class="pct">${yn ? Math.round(100 * s.yw / yn) : 0}% win</div></div>
      <div class="sc ${s.aw > s.yw ? 'lead' : ''}"><div class="who">AI</div>
        <div class="n">${s.aw}–${s.al}</div>
        <div class="pct">${an ? Math.round(100 * s.aw / an) : 0}% win</div></div>
    </div>
    ${skillHtml}
    <div id="rows"></div>`;

  const rows = $('rows');
  for (let i = M.rounds.length - 1; i >= 0; i--) {
    const r = M.rounds[i];
    if (!r.you.result && !r.you.moves.length) continue;      // untouched current seed
    const row = document.createElement('div');
    row.className = 'srow';
    const c = document.createElement('canvas'); c.width = 46; c.height = 46;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.innerHTML = `<div class="sd">#${i + 1} · seed ${r.seed}</div>`
      + `<div class="vs">You ${resTag(r.you.result)} &nbsp;·&nbsp; AI ${resTag(r.ai.result)}</div>`;
    const go = document.createElement('div'); go.className = 'go'; go.textContent = r.trim ? '' : '›';
    row.appendChild(c); row.appendChild(meta); row.appendChild(go);
    if (r.trim) {                 // replay detail was trimmed to fit storage — result only
      row.style.opacity = '.55';
      meta.querySelector('.sd')!.textContent += ' · detail trimmed';
    } else {
      row.onclick = () => { closeRes(); openSeed(i, { fromResults: true }); };
    }
    rows.appendChild(row);
    if (r.startNodes) drawThumb(c, r.startNodes);
  }
  $('ov-res').classList.add('show');
  document.querySelectorAll<HTMLElement>('#skzoom button').forEach(el => {
    el.onclick = () => setSkillZoom(el.dataset.z!);
  });
  if ($('sk')) $('sk').onclick = skTap;
  // paint AFTER show — the canvas sizes itself from getBoundingClientRect,
  // which is 0x0 while the overlay is still display:none
  refreshSkill();
  scorePump();                       // anything still unscored gets picked up now
}

$('tally').onclick = showResults;
const closeRes = () => $('ov-res').classList.remove('show');
$('res-close').onclick = closeRes;
$('res-reset').onclick = () => {
  if (!confirm('Reset the whole tally? Every seed, result and review is discarded.')) return;
  try { localStorage.removeItem(KEY); } catch (_) {}
  location.reload();
};

// ============================ red-power graph ============================
// ONE graph, both players: red node count per turn, you vs the AI on the same axes —
// the whole point is the comparison, and two separate panels made you eyeball it.
// Node count (not total strength) is the plotted power: it's the win condition (24).
const YOU_COL = '#5fd0d6', AI_COL = '#f5c542';
let pgHit: { W: number; padL: number; padR: number; maxT: number } | null = null;   // for tap-to-scrub
// cursor: the turn of the move on the inspector's board, in its side's color.
function drawPower(cv: HTMLCanvasElement, r: Round, cursor: { t: number; col: string } | null) {
  const you = r.you.hist, ai = r.ai.hist;
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width)), H = Math.max(1, Math.round(rect.height));
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const all = [...you, ...ai];
  const padL = 5, padR = 5, padT = 6, padB = 5;
  const maxT = Math.max(2, ...all.map(p => p.t));
  pgHit = all.length ? { W, padL, padR, maxT } : null;
  const maxN = Math.max(WIN_NODES, ...all.map(p => p.n));
  const xOf = (t: number) => padL + (t - 1) / (maxT - 1) * (W - padL - padR);
  const yOf = (v: number) => padT + (1 - v / maxN) * (H - padT - padB);
  if (!all.length) {
    g.fillStyle = '#5f9e8e'; g.font = '11px -apple-system, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('no data yet', W / 2, H / 2);
    return;
  }
  // the 24-node win line
  g.strokeStyle = 'rgba(54,211,154,.30)'; g.lineWidth = 1; g.setLineDash([3, 4]);
  g.beginPath(); g.moveTo(0, yOf(WIN_NODES) + .5); g.lineTo(W, yOf(WIN_NODES) + .5); g.stroke();
  g.setLineDash([]);
  const series = (h: HistPoint[], col: string) => {
    if (!h.length) return;
    g.beginPath();
    h.forEach((p, i) => i ? g.lineTo(xOf(p.t), yOf(p.n)) : g.moveTo(xOf(p.t), yOf(p.n)));
    g.strokeStyle = col; g.lineWidth = 2.1; g.lineJoin = 'round';
    g.shadowColor = col; g.shadowBlur = 5; g.stroke(); g.shadowBlur = 0;
    const last = h[h.length - 1];
    g.fillStyle = col;
    g.beginPath(); g.arc(xOf(last.t), yOf(last.n), 3, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#02100b'; g.lineWidth = 1; g.stroke();
  };
  // Expected win% overlays: the SAME two entities, dotted, on their own implicit
  // scale — 0-100% over the full plot height (so 50% is mid-plot; the dashed
  // 24-line belongs to the node scale). Dotted drawn under solid, thinner and
  // without glow, so node count stays the dominant read.
  const yQ = (q: number) => padT + (1 - q) * (H - padT - padB);
  const qseries = (h: CurvePoint[], col: string) => {
    if (!h.length) return;
    g.beginPath();
    let connected = false;
    for (const p of h) {
      if (p.q == null || !Number.isFinite(p.q)) { connected = false; continue; }
      if (connected) g.lineTo(xOf(p.t), yQ(p.q));
      else g.moveTo(xOf(p.t), yQ(p.q));
      connected = true;
    }
    g.setLineDash([2, 3.5]); g.strokeStyle = col; g.lineWidth = 1.5;
    g.lineJoin = 'round'; g.stroke(); g.setLineDash([]);
    const last = h[h.length - 1];
    if (last.q != null && Number.isFinite(last.q)) {
      g.fillStyle = col;
      g.beginPath(); g.arc(xOf(last.t), yQ(last.q), 2, 0, Math.PI * 2); g.fill();
    }
  };
  if (cursor) {
    const x = Math.round(xOf(cursor.t)) + .5;
    g.strokeStyle = cursor.col; g.globalAlpha = .55; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.globalAlpha = 1;
  }
  qseries(aiWinCurve(r.ai.moves), AI_COL);
  qseries(youWinCurve(r.you.review, r.you.moves), YOU_COL);
  series(ai, AI_COL);          // AI first so your line reads on top
  series(you, YOU_COL);
}

function redrawSeedGraphs(r: Round) {
  if (!$('pg')) return;
  const side = sdTab === 'you' ? r.you : r.ai;
  drawPower($<HTMLCanvasElement>('pg'), r, sdSel < 0 ? null
    : { t: moveTurns(side.moves)[sdSel], col: sdTab === 'you' ? YOU_COL : AI_COL });
}

// Tap the seed graph → scrub the inspector to that turn: x maps back to a turn,
// and the first of the active side's moves on (or after) it gets selected.
function moveTurns(moves: Move[]) {
  const ts: number[] = []; let t = 1;                  // end-turn moves advance the turn
  for (const mv of moves) { ts.push(t); if (mv.e) t++; }
  return ts;
}
function pgTap(ev: MouseEvent) {
  if (!pgHit) return;
  const frac = (ev.offsetX - pgHit.padL) / (pgHit.W - pgHit.padL - pgHit.padR);
  const t = Math.round(1 + Math.min(1, Math.max(0, frac)) * (pgHit.maxT - 1));
  const side = sdTab === 'you' ? M.rounds[sdIdx].you : M.rounds[sdIdx].ai;
  const ts = moveTurns(side.moves);
  if (!ts.length) return;
  let k = ts.findIndex(x => x >= t);
  if (k < 0) k = ts.length - 1;
  select(k);
}

// ============================ per-seed detail ============================
let sdIdx = 0, sdTab: 'you' | 'ai' = 'you', sdSel = -1, ib: Board | null = null, sdFromResults = false;

const resTag = (x: Side['result']) => `<span class="tag ${x || 'none'}">${x === 'won' ? 'W' : x === 'lost' ? 'L' : '—'}</span>`;
// Only a finished game gets a final score — mid-game the AI's node count is not a
// result and must not be dressed up as one.
// The tabs double as the chart's key (their colors) and carry each side's result.
const sdResult = (side: Side) => !side.hist.length ? 'queued' : !side.result ? 'playing…'
  : `${side.forfeit ? 'forfeit' : side.result} · ${side.turns} turn${side.turns === 1 ? '' : 's'}`;
const SD_LEGEND = '<span><i></i>red nodes</span><span><i class="dashq"></i>win%</span>';

// The AI plays concurrently, so an analysis auto-opened after your loss usually shows
// its half unfinished. Fill it in the moment it lands rather than leaving a stale
// "playing…" panel with an empty strip that never updates. Deliberately does NOT
// re-run openSeed: that would reset your tab, selection and re-trigger scoring.
function refreshSeedPanel(i: number) {
  if (!$('ov-seed').classList.contains('show') || sdIdx !== i) return;
  if (sdTab === 'ai' && sdSel < 0) select(0);          // its strip was empty before
  else paintSel();
}

function openSeed(i: number, opts: { fromResults?: boolean; sel?: number } = {}) {
  const r = M.rounds[i];
  if (r.trim) { if (opts.fromResults) showResults(); return; }   // nothing to replay
  sdIdx = i; sdSel = -1;
  sdFromResults = !!opts.fromResults;
  // The AI's game is the one to learn from, so it opens first; a tap on one of your
  // decisions (the tally's graph) or an AI still on its first move opens yours.
  sdTab = opts.sel == null && r.ai.moves.length ? 'ai' : 'you';
  $('sd-title').textContent = `Seed ${i + 1}`;
  // The board on top, the controls at the bottom under the thumb.
  $('sd-body').innerHTML = `
    <div id="ibwrap"><canvas id="ib"></canvas></div>
    <div id="ibcap"><span id="ibinfo"></span><span id="ibgrade"></span></div>
    <canvas class="pg" id="pg"></canvas>
    <div id="glegend">${SD_LEGEND}</div>
    <div class="tabs" id="sd-tabs">
      <div data-tab="ai" class="ai"></div>
      <div data-tab="you"></div>
    </div>
    <div id="ibnav">
      <div id="sd-strip"></div>
      <div class="act" id="ib-prev" aria-label="Previous move">‹</div>
      <div class="act" id="ib-next" aria-label="Next move">›</div>
    </div>`;
  // Show BEFORE painting: every canvas here sizes itself from getBoundingClientRect,
  // which is 0x0 while the overlay is still display:none.
  $('ov-seed').classList.add('show');
  ib = new Board($<HTMLCanvasElement>('ib'), $('ibwrap'));
  ib.pad = 16;
  ib.reviewColors = true;
  $('pg').onclick = pgTap;
  document.querySelectorAll<HTMLElement>('#sd-tabs > div').forEach(el => {
    el.onclick = () => { sdTab = el.dataset.tab === 'ai' ? 'ai' : 'you'; sdSel = -1; select(0); };
  });
  $('ib-prev').onclick = () => step(-1);
  $('ib-next').onclick = () => step(1);
  stripScrub($('sd-strip'));
  select(opts.sel ?? 0);       // a graph tap lands directly on its decision
  // Scoring IS the analysis — start it the moment the panel opens, no button.
  if ((!r.you.review || r.you.review.partial) && r.you.moves.length) runReview(i);
  aiPump();
}
// Back returns wherever you came from: the tally if you drilled in from it, otherwise
// (auto-opened after a loss) straight back to the seed you're now playing.
$('sd-close').onclick = () => {
  ++inspectSeq;
  $('ov-seed').classList.remove('show');
  if (sdFromResults) showResults();
};
addEventListener('keydown', e => {
  if (!$('ov-seed').classList.contains('show')) return;
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
});

const sdSide = () => sdTab === 'you' ? M.rounds[sdIdx].you : M.rounds[sdIdx].ai;

// Everything about the selection except the board: tabs, the move strip, the chart
// cursor and the grade. Cheap, so review progress repaints it freely.
function paintSel() {
  const r = M.rounds[sdIdx], side = sdSide();
  for (const el of document.querySelectorAll<HTMLElement>('#sd-tabs > div')) {
    const you = el.dataset.tab === 'you';
    el.textContent = `${you ? 'You' : 'AI'} · ${sdResult(you ? r.you : r.ai)}`;
    el.classList.toggle('sel', (sdTab === 'you') === you);
  }
  // One bar per move, with a gap after each end turn so the turns read as groups.
  // On your moves a bar hangs down by the win% the review says it gave up, filling
  // in as scoring lands. No hues: red/yellow/green are factions on the board.
  const rv = sdTab === 'you' ? side.review : null;
  $('sd-strip').innerHTML = side.moves.map((mv, k) => {
    const sm = rv?.moves[k];
    const cls = sdTab === 'ai' ? 'ai' : !sm ? 'pend' : sm.dead ? 'dead' : '';
    const lost = sm && !sm.dead && sm.gap != null ? Math.min(1, sm.gap / 30) : 0;
    return `<i class="${cls}${mv.e ? ' end' : ''}${k === sdSel ? ' cur' : ''}"`
      + ` style="--lost:${lost.toFixed(2)}"></i>`;
  }).join('');
  if (!side.moves.length) {
    $('sd-strip').innerHTML = `<span class="spin">${sdTab === 'ai'
      ? 'The AI hasn\'t finished this seed yet.' : 'No moves recorded.'}</span>`;
  }
  redrawSeedGraphs(r);
  paintGrade();
}

// Your move's grade beside the caption, with the search's preferred move drawn on
// the board dashed in white. The AI's moves carry the win% its own search reported.
function paintGrade() {
  const el = $('ibgrade'), side = sdSide(), mv = side.moves[sdSel];
  el.onclick = null;
  if (ib) ib.bestMove = null;
  if (!mv) { el.innerHTML = ''; return; }
  if (sdTab === 'ai') { el.innerHTML = mv.q != null ? `${Math.round(mv.q * 100)}% win` : ''; return; }
  const sm = side.review?.moves[sdSel];
  if (!sm) {
    if (reviewErr[sdIdx] && !reviewing.has(sdIdx)) {
      el.innerHTML = '<span class="retry">Scoring failed · retry</span>';
      el.onclick = () => runReview(sdIdx);
    } else el.innerHTML = '<span class="pend">scoring…</span>';
    return;
  }
  if (sm.dead) { el.innerHTML = '<span class="pend">decided</span>'; return; }
  if (sm.gap == null) { el.innerHTML = ''; return; }
  if (sm.gap < 0.5) { el.innerHTML = '<b>Best</b>'; return; }
  el.innerHTML = `<b>${tierOf(sm.gap).label}</b> −${sm.gap.toFixed(0)}%`
    + (sm.bestLbl === 'end' ? ' · best: end turn' : ' · best <i class="dash"></i>');
  // Labels carry grid x/y, which identify the nodes on the replayed board.
  const s = ib?.state, b = sm.bestLbl;
  if (ib && s && b && b !== 'end') {
    const id = (p: Pip) => s.nodes.find(n => n.x === p.x && n.y === p.y)?.id;
    ib.bestMove = { from: id(b.f), to: id(b.t) };
  }
  ib?.draw();
}

// Tap or drag along the strip to jump to a move.
function stripScrub(strip: HTMLElement) {
  const at = (x: number) => {
    const cells = [...strip.children].filter(c => c.tagName === 'I');
    let k = cells.findIndex(c => c.getBoundingClientRect().right >= x);
    if (k < 0) k = cells.length - 1;
    if (k >= 0 && k !== sdSel) select(k);
  };
  strip.onpointerdown = e => { strip.setPointerCapture(e.pointerId); at(e.clientX); };
  strip.onpointermove = e => { if (strip.hasPointerCapture(e.pointerId)) at(e.clientX); };
}

// ---- move inspector: replay the seed to move k and show that exact board ----
let inspectSeq = 0;
// Paint the board as it stood going into move k (bit-exact replay from the seed).
async function showMove(k: number) {
  const r = M.rounds[sdIdx];
  const side = sdSide();
  if (k < 0 || k >= side.moves.length) return;
  const my = ++inspectSeq;
  let s: GameView;
  try { s = await inspectMove(r.seed, side.moves, k, r.rules ?? LEGACY_RULES_VERSION); }
  catch (e) {
    if (my === inspectSeq) $('ibinfo').textContent = `Replay failed: ${e instanceof Error ? e.message : e}`;
    return;
  }
  if (my !== inspectSeq) return;                 // a newer selection superseded this
  const mv = side.moves[k];
  if (!ib) return;
  ib.setView(s);
  // highlight the move about to be played
  ib.hoverMove = mv.e ? null : { from: mv.a[0], to: mv.a[1] };
  ib.resize();
  $('ibinfo').innerHTML = `<b>Move ${k + 1}</b>/${side.moves.length} · turn ${s.turn}`
    + `${mv.e ? ' <span class="pill">end turn</span>' : ''}`;
  paintGrade();
}
function select(k: number) {
  const side = sdSide();
  if (side.moves.length && (k < 0 || k >= side.moves.length)) return;
  sdSel = side.moves.length ? k : -1;
  paintSel();
  if (sdSel < 0) { if (ib) { ib.state = null; ib.resize(); } $('ibinfo').textContent = ''; return; }
  showMove(k);
}
const step = (d: number) => select(sdSel < 0 ? 0 : sdSel + d);

const reviewing = new Set<number>();          // round indices being scored (transient — never saved)
const reviewErr: Record<number, string> = {}; // last scoring error per round index (transient)
const seedPanelOn = (i: number) => sdIdx === i && $('ov-seed').classList.contains('show');
// Coalesce completions from multiple workers into one visible update per frame.
let reviewPaint = 0;
function scheduleReviewPaint() {
  if (reviewPaint) return;
  reviewPaint = requestAnimationFrame(() => {
    reviewPaint = 0;
    if (seedPanelOn(sdIdx)) paintSel();
    refreshSkill();
  });
}
async function runReview(i: number) {
  if (reviewing.has(i)) return;
  reviewing.add(i);
  delete reviewErr[i];
  refreshSkill();
  const r = M.rounds[i];
  let checkpointAt = performance.now();
  if (seedPanelOn(i)) paintSel();  // swap a retry line to 'scoring…'
  try {
    // Rolling readout: every scored move lands in r.you.review immediately
    // (marked .partial, so the move strip shows pending cells) — the early
    // rows are readable while the rest are still searching, and both the
    // tally's skill graph and this seed's win% panel fill in as they land.
    // Checkpoint finished positions at most once a second. Reloads/retries resume
    // the same version + action sequence without repeating expensive searches.
    r.you.review = await reviewer.grade(r, (partial) => {
      r.you.review = partial;
      scheduleReviewPaint();
      if (performance.now() - checkpointAt >= 1000) {
        checkpointAt = performance.now();
        save();
      }
    }, () => seedPanelOn(i) ? Number.MAX_SAFE_INTEGER : i);
    save();
  } catch (e) {
    reviewErr[i] = e instanceof Error ? e.message : String(e);
    reportError('review', `seed ${i + 1}: ${errMsg(e)}`);
    save();                          // keep completed positions available for retry
  } finally {
    reviewing.delete(i);
  }
  if (seedPanelOn(i)) paintSel();
  refreshSkill();
}

// ============================ background scorer ============================
// Reviews used to exist only for seeds whose analysis you opened — and since a
// loss auto-opens its analysis and a win doesn't, the skill graph skewed toward
// your bad games. This pump scores EVERY finished seed for as long as the page
// is open, NEWEST first: the seed you just finished is the one you're waiting
// on, and the backlog fills in behind it. A seed already being scored from an
// open panel (`reviewing`) is skipped, as is one that failed this session
// (reviewErr — either analysis panel can retry it); a completed review
// persists, so progress survives reloads.
let scoreBusy = false;
async function scorePump() {
  if (scoreBusy) return;
  scoreBusy = true;
  try {
    for (;;) {
      let i = -1;
      for (let k = M.rounds.length - 1; k >= 0; k--) {
        const r = M.rounds[k];
        if (r.you.result && r.you.moves.length && !(r.you.review && !r.you.review.partial)
            && !reviewing.has(k) && !reviewErr[k]) { i = k; break; }
      }
      if (i < 0) break;
      await runReview(i);
      // A failed game is marked in reviewErr; continue analyzing the rest.
    }
  } finally {
    scoreBusy = false;
  }
}

// ============================ menu (hamburger) ============================
// Seed sharing, the sweep-up toggle and data export/import.
const menupop = $('menupop');
$('menu').onclick = () => menupop.classList.toggle('show');
document.addEventListener('click', (e) => {
  if (menupop.classList.contains('show') && !$('menuwrap').contains(e.target as Node))
    menupop.classList.remove('show');
});

// ---- seed sharing: copy the seed being played, or paste one (yours or a
// friend's) to play it as THIS round — the current round is re-dealt on the
// pasted seed, and the AI pump picks it up like any other. If it was mid-game
// on the old seed it finishes into the detached round object, harmlessly. ----
$('mi-copy').onclick = async () => {
  menupop.classList.remove('show');
  const seed = cur().seed;
  try { await navigator.clipboard.writeText(String(seed)); }
  catch (_) { prompt('Copy the seed:', String(seed)); }   // clipboard blocked — show it instead
};
$('mi-paste').onclick = async () => {
  menupop.classList.remove('show');
  if (inputLocked || sweeping) return;
  const v = prompt('Paste a seed to play it as this round:');
  if (v == null) return;
  const seed = parseInt(String(v).trim(), 10);
  if (!Number.isInteger(seed) || seed < 1 || seed > 0x7fffffff) { alert('Not a valid seed.'); return; }
  const r = cur();
  if (r.you.moves.length && !r.you.result && !confirm('Abandon the seed in progress?')) return;
  M.rounds[M.idx] = blankRound(seed);
  save();
  renderStrip();
  await startSeed();
};
// Give up the seed in progress: a loss like any other, so the AI still plays the seed
// and the analysis opens over the next one.
$('mi-forfeit').onclick = async () => {
  menupop.classList.remove('show');
  if (!state || state.over || inputLocked || sweeping) return;
  if (!confirm(`Forfeit Seed ${M.idx + 1}? It counts as a loss.`)) return;
  cancelSweepOffer();
  const side = cur().you;
  Object.assign(side, { result: 'lost', forfeit: 1, turns: state.turn, red: state.counts.red });
  save();
  // The board still holds a live game until the next seed is dealt.
  inputLocked = true; board.selected = null; board.draw();
  try { await afterYourGame(); } finally { inputLocked = false; }
};

const SETTINGS = ['nwSweep', 'nwSpeed', 'nwSkillZoom'];
// ---- data export: the whole tally (every seed, move list and review) + settings as
// one JSON download, plus the session's diagnostics (see `diag`). The in-memory
// tally is exported, not the stored copy: it is never older, and if saves have been
// failing it is the only complete one. ----
$('mi-export').onclick = () => {
  menupop.classList.remove('show');
  save();
  const get = (k: string) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const tally = JSON.stringify(M), stored = get(KEY), now = performance.now();
  const data = {
    app: 'network-wars-h2h', exported: new Date().toISOString(),
    tally: M,
    settings: Object.fromEntries(SETTINGS.map(k => [k, get(k)])),
    diagnostics: {
      userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
      reviewWorkers: reviewer.workers, tallyChars: tally.length,
      storedChars: stored == null ? null : stored.length, storedInSync: stored === tally,
      aiBusy, aiErr, reviewErr, reviewing: [...reviewing],
      inFlight: engines.flatMap(e => [...e.pending.values()].map(p =>
        ({ engine: e.name, path: p.path, ageS: Math.round(now - p.t) / 1000 }))),
      ...diag,
    },
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `network-wars-${data.exported.slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

// ---- data import: replace the tally + settings with a Save Data export (e.g. to
// move a tally to another deploy, since localStorage is per origin). The page then
// reloads so the workers and pumps start over on the imported tally; until then
// saves are frozen so in-flight AI/review results for the old tally can't write
// into it. Diagnostics and the error log are not imported. ----
const importInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
$('mi-import').onclick = () => { menupop.classList.remove('show'); importInput.click(); };
importInput.onchange = async () => {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { alert('Not a JSON file.'); return; }
  const t = data?.tally;
  if (data?.app !== 'network-wars-h2h' || !t || !Array.isArray(t.rounds) || !t.rounds.length
      || !Number.isInteger(t.idx) || !t.rounds[t.idx]) {
    alert('Not a Network Wars data export.'); return;
  }
  if (!confirm(`Replace this tally (${M.rounds.length} seeds) with the file's (${t.rounds.length} seeds)?`)) return;
  const old = M;
  M = t;
  if (!save()) { M = old; save(); alert('Could not store the imported tally.'); return; }
  saveFrozen = true;
  for (const k of SETTINGS) {
    const v = data.settings?.[k];
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {}
  }
  location.reload();
};

// ---- error log: a menu item + panel (see reportError), counted in the menu only,
// so harmless errors add no noise to the board ----
function renderErrors() {
  const n = diag.errors.reduce((a, e) => a + e.n, 0);
  $('mi-errn').textContent = n ? String(n) : '';
  if ($('ov-err').classList.contains('show')) fillErrPanel();
}
// Is this tab running the latest deploy? A resumed phone tab keeps the code it
// loaded, and sw.js serves the cached page when the network stalls. Ask the
// network for the current page (sw.js lets this through) and compare releases.
let latestRelease: string | null = null;   // null: not checked, offline, or dev
async function checkLatest() {
  if (RELEASE === 'dev') return;
  try {
    const html = await (await fetch('./', { cache: 'no-store' })).text();
    latestRelease = html.match(/<meta name="release" content="([^"]+)"/)?.[1] ?? null;
  } catch (_) { latestRelease = null; }
  renderErrors();
}
const short = (v: string) => v.slice(0, 7);
// What was running when you looked: version, device, AI state, and any request still waiting.
function errContext() {
  const now = performance.now(), s = (ms: number) => (ms / 1000).toFixed(1) + 's';
  const inFlight = engines.flatMap(e => [...e.pending.values()].map(p =>
    `${e.name} ${p.path} ${s(now - p.t)}`));
  return [
    `version ${short(RELEASE)}` + (latestRelease == null ? ''
      : latestRelease === RELEASE ? ' (latest)' : ` — newer ${short(latestRelease)} deployed, reload`),
    navigator.userAgent,
    `cores ${navigator.hardwareConcurrency} · review workers ${reviewer.workers}`
      + ` · AI ${aiBusy ? 'busy' : 'idle'} · failed saves ${diag.saveFails}`,
    `AI searches ${diag.aiSearches}`
      + (diag.aiSearches ? `, avg ${s(diag.aiSearchMs / diag.aiSearches)}, max ${s(diag.aiSearchMaxMs)}` : ''),
    `in flight: ${inFlight.join('; ') || 'none'}`,
  ].join('\n');
}
function fillErrPanel() {
  const list = $('err-list');
  list.innerHTML = '';
  if (!diag.errors.length) {
    const none = document.createElement('div');
    none.className = 'err-meta';
    none.textContent = 'No errors recorded.';
    list.appendChild(none);
  }
  for (const e of diag.errors.slice().reverse()) {             // newest first
    const row = document.createElement('div');
    row.className = 'err' + (e.prev ? ' prev' : '');
    const meta = document.createElement('div');
    meta.className = 'err-meta';
    // Entries without `v` were recorded before errors carried a version: older code.
    meta.textContent = [new Date(e.at).toLocaleString(), e.src, e.n > 1 ? `×${e.n}` : '',
      e.prev ? 'earlier session' : '', e.v !== RELEASE ? 'older version' : '']
      .filter(Boolean).join(' · ');
    const msg = document.createElement('div');
    msg.className = 'err-msg';
    msg.textContent = e.msg;
    row.append(meta, msg);
    if (e.trail?.length) {
      const trail = document.createElement('div');
      trail.className = 'err-trail';
      trail.textContent = e.trail.join('\n');
      row.append(trail);
    }
    list.appendChild(row);
  }
  $('err-ctx').textContent = errContext();
}
$('mi-errors').onclick = () => {
  menupop.classList.remove('show');
  fillErrPanel();
  $('ov-err').classList.add('show');
  checkLatest();
};
$('err-close').onclick = () => $('ov-err').classList.remove('show');
$('err-copy').onclick = async () => {
  const text = diag.errors.map(e => `${e.at} ${e.src}${e.n > 1 ? ` x${e.n}` : ''}`
    + `${e.prev ? ' (earlier session)' : ''} [${e.v ? short(e.v) : 'old'}]\n${e.msg}`
    + (e.trail?.length ? `\nbefore it:\n${e.trail.join('\n')}` : ''))
    .join('\n\n') + '\n\n' + errContext();
  try {
    await navigator.clipboard.writeText(text);
    $('err-copy').textContent = 'Copied';
    setTimeout(() => { $('err-copy').textContent = 'Copy'; }, 1500);
  } catch (_) { prompt('Copy the errors:', text); }       // clipboard blocked — show it instead
};
$('err-clear').onclick = () => {
  diag.errors = [];
  try { localStorage.removeItem(ERR_KEY); } catch (_) {}
  $('ov-err').classList.remove('show');
  renderErrors();
};
renderErrors();                        // earlier sessions' errors count in the menu on load

// ============================ boot ============================
// Resume: your recorded moves replay back into a fresh game for the seed in progress
// (bit-exact from the seed), so a reload mid-game doesn't cost you the game. The AI
// pump independently re-plays any seed it hadn't finished.
async function resume() {
  const r = cur();
  if (r.you.result) {                            // you'd finished; move on to a new seed
    M.rounds.push(blankRound(randSeed()));
    M.idx = M.rounds.length - 1;
    save();
    await startSeed();
    return;
  }
  const moves = r.you.moves.slice();
  await startSeed();                             // deals the seed + kicks the AI pump
  if (!moves.length) return;
  const sp = board.speed; board.speed = 0;       // replay instantly
  let s = state!;
  for (const mv of moves) {
    s = mv.e ? await api(`/api/game/${s.id}/end-turn`, 'POST')
             : await api(`/api/game/${s.id}/attack`, 'POST', { from: mv.a[0], to: mv.a[1] });
    sampleHist(r.you, s);
  }
  board.speed = sp;
  r.you.moves = moves;                           // startSeed cleared the log
  save();
  adopt(s); resize(); renderStrip();
  if (recordEnd(r.you, s)) { await afterYourGame(); return; }
  thinkStart();                                  // restart the clock after the replay
}

// Straight into a game: no intro gate. A stored tally resumes where you left off,
// otherwise the first seed is dealt immediately.
const prev = load();
if (prev) { M = prev; renderStrip(); resume(); scorePump(); }
else {
  M = { rounds: [blankRound(randSeed())], idx: 0 };
  save();
  startSeed();
}
