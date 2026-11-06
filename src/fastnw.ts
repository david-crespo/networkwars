// Marshalling layer over the engine's WASM build (src/nw_engine.wasm, built from
// engine/ by engine/build.sh) — the browser/worker and the node gates talk to the
// engine through this. Direct port of solver/fastnw.py: it copies int32 arrays into
// the wasm heap, calls the exported C-ABI functions, and copies results back. It
// implements NO game rules itself: the engine is the single source of truth for
// board-gen, the four bots, the fair-coin-attrition battle, reinforcement, and the
// UCT search.
//
// owner encoding: red=0, green=1, yellow=2, blue=3, purple=4 (= FACTIONS index).
// Two RNG streams in the engine: useMb32(seed) = the real seeded mulberry32 game
// stream; useSim(seed) = the private seed-free splitmix64 stream for search rollouts.
import type { Faction, Move, MoveRef } from './types.ts';
import { LEGACY_RULES_VERSION, RULES_VERSION } from './game-version.ts';
export { RULES_VERSION } from './game-version.ts';

export const FACTIONS: readonly Faction[] = ['red', 'green', 'yellow', 'blue', 'purple'];
export const FIDX = Object.fromEntries(FACTIONS.map((f, i) => [f, i])) as Record<Faction, number>;
export const MAXN = 64;

const WASM = new URL('./nw_engine.wasm', import.meta.url);

async function wasmBytes(): Promise<BufferSource> {
  if (WASM.protocol === 'file:') {   // node (the gates): its fetch can't read files
    const fs = 'node:fs/promises';   // a variable, so Vite leaves it out of the page
    return (await import(/* @vite-ignore */ fs)).readFile(WASM);
  }
  return (await fetch(WASM)).arrayBuffer();
}

// The benches pass another build's bytes to compare against this one.
export async function loadEngine(bytes?: BufferSource) {
  const { instance } = await WebAssembly.instantiate(bytes ?? await wasmBytes(), {});
  return new Engine(instance.exports as unknown as Exports);
}

// Pointers are byte offsets into the wasm memory; int32 arrays go through i32.
type Ptr = number;
export type Adj = number[][];
export type Link = [number, number];

/** The engine's wasm exports (engine/nw-abi), through a C ABI. */
export interface Exports {
  memory: WebAssembly.Memory;
  nw_malloc(bytes: number): Ptr;
  nw_free(ptr: Ptr): void;

  new_game(seed: number, owner: Ptr, strength: Ptr, x: Ptr, y: Ptr): number;
  new_game_legacy(seed: number, owner: Ptr, strength: Ptr, x: Ptr, y: Ptr): number;
  set_topology(n: number, adjOff: Ptr, adjList: Ptr): void;
  get_adj(adjOff: Ptr, adjList: Ptr): void;
  get_links(links: Ptr): number;

  set_rng_mb32(seed: number): void;
  get_rng_mb32(): number;
  set_sim_seed(seed: bigint): void;
  use_mb32_rng(): void;
  use_sim_rng(): void;

  ext_attack_legal(owner: Ptr, strength: Ptr, from: number, to: number): number;
  ext_check_winner(owner: Ptr): number;
  ext_reinforce(owner: Ptr, strength: Ptr, faction: number): void;
  ext_resolve_battle(owner: Ptr, strength: Ptr, from: number, to: number): void;
  resolve_battle_logged(owner: Ptr, strength: Ptr, from: number, to: number,
    flips: Ptr, len: Ptr, meta: Ptr): void;
  end_turn(owner: Ptr, strength: Ptr): void;
  bot_turn_begin(owner: Ptr, strength: Ptr, faction: number, cursor: Ptr): void;
  bot_turn_next(owner: Ptr, strength: Ptr, faction: number, cursor: Ptr): number;
  sweep_best_move(owner: Ptr, strength: Ptr): number;
  sweep_certify(owner: Ptr, strength: Ptr, turns: number, trials: number, maxLosses: number): number;

  uct_search(owner: Ptr, strength: Ptr, turns: number, sims: number, maxSims: number,
    cPuct: number, nroll: number, acts: Ptr, visits: Ptr, q: Ptr): number;
  uct_begin(owner: Ptr, strength: Ptr, turns: number, sims: number, maxSims: number,
    cPuct: number, nroll: number): number;
  uct_step(budget: number): number;
  uct_report(acts: Ptr, visits: Ptr, q: Ptr): number;
  uct_sims_done(): number;
  uct_set_value_stop(lo: number, hi: number, gap: number, minVisits: number): void;
  uct_set_grade(mode: number): void;
}

/** Root children of a search: action (-1 = end turn, else from << 8 | to), visits, Q. */
export interface RootStats { acts: Int32Array; visits: Int32Array; q: Float64Array }

export class Engine {
  wasm: Exports;
  _owner: Ptr; _strength: Ptr; _x: Ptr; _y: Ptr; _adjOff: Ptr; _adjList: Ptr; _links: Ptr;
  _flips: Ptr; _len: Ptr; _meta: Ptr; _acts: Ptr; _visits: Ptr; _q: Ptr;
  // Views of the wasm memory, replaced when a search grows it.
  #buffer?: ArrayBuffer; #i32 = new Int32Array(); #f64 = new Float64Array();

  constructor(wasm: Exports) {
    this.wasm = wasm;
    // persistent scratch buffers in the wasm heap (mirror fastnw.py's module bufs)
    this._owner = wasm.nw_malloc(MAXN * 4);
    this._strength = wasm.nw_malloc(MAXN * 4);
    this._x = wasm.nw_malloc(MAXN * 4);
    this._y = wasm.nw_malloc(MAXN * 4);
    this._adjOff = wasm.nw_malloc((MAXN + 1) * 4);
    this._adjList = wasm.nw_malloc(MAXN * 8 * 4);
    this._links = wasm.nw_malloc(MAXN * 8 * 2 * 4);
    this._flips = wasm.nw_malloc(4096 * 4);
    this._len = wasm.nw_malloc(4);
    this._meta = wasm.nw_malloc(5 * 4);
    this._acts = wasm.nw_malloc(4096 * 4);
    this._visits = wasm.nw_malloc(4096 * 4);
    this._q = wasm.nw_malloc(4096 * 8);     // doubles
  }

  get i32() { this.#views(); return this.#i32; }
  get f64() { this.#views(); return this.#f64; }
  #views() {
    const b = this.wasm.memory.buffer;
    if (b !== this.#buffer) { this.#buffer = b; this.#i32 = new Int32Array(b); this.#f64 = new Float64Array(b); }
  }

  // ---- heap <-> Int32Array helpers ----
  _put(ptr: Ptr, arr: ArrayLike<number>) {
    this.i32.set(arr, ptr >> 2);
  }
  _get(ptr: Ptr, n: number) {
    return this.i32.slice(ptr >> 2, (ptr >> 2) + n);
  }
  _getBack(ptr: Ptr, arr: Int32Array) {
    arr.set(this.i32.subarray(ptr >> 2, (ptr >> 2) + arr.length));
  }

  // ---- topology ----
  setTopologyCsr(n: number, adj: Adj) {
    const off = new Int32Array(n + 1);
    const flat: number[] = [];
    for (let i = 0; i < n; i++) { off[i] = flat.length; for (const j of adj[i]) flat.push(j); }
    off[n] = flat.length;
    this._put(this._adjOff, off);
    this._put(this._adjList, Int32Array.from(flat));
    this.wasm.set_topology(n, this._adjOff, this._adjList);
    return n;
  }

  getAdj(n: number): Adj {
    this.wasm.get_adj(this._adjOff, this._adjList);
    const off = this._get(this._adjOff, n + 1);
    const lst = this._get(this._adjList, off[n]);
    const adj: Adj = [];
    for (let i = 0; i < n; i++) adj.push(Array.from(lst.subarray(off[i], off[i + 1])));
    return adj;
  }

  getLinks(): Link[] {
    const L = this.wasm.get_links(this._links);
    const raw = this._get(this._links, 2 * L);
    const links: Link[] = [];
    for (let k = 0; k < L; k++) links.push([raw[2 * k], raw[2 * k + 1]]);
    return links;
  }

  // ---- board generation ----
  newGame(seed: number, rules = RULES_VERSION) {
    if (rules !== LEGACY_RULES_VERSION && rules !== RULES_VERSION) throw new Error('unsupported rules version');
    const generate = rules === LEGACY_RULES_VERSION ? this.wasm.new_game_legacy : this.wasm.new_game;
    const n = generate(seed >>> 0, this._owner, this._strength, this._x, this._y);
    return {
      n,
      owner: this._get(this._owner, n),
      strength: this._get(this._strength, n),
      x: this._get(this._x, n),
      y: this._get(this._y, n),
      adj: this.getAdj(n),
      links: this.getLinks(),
      mb: this.wasm.get_rng_mb32() >>> 0,
    };
  }

  // ---- rng ----
  useMb32(seed: number) { this.wasm.set_rng_mb32(seed >>> 0); this.wasm.use_mb32_rng(); }
  useSim(seed: number) { this.wasm.set_sim_seed(BigInt(seed)); this.wasm.use_sim_rng(); }
  getMb32() { return this.wasm.get_rng_mb32() >>> 0; }
  setMb32(v: number) { this.wasm.set_rng_mb32(v >>> 0); }

  // ---- pure-JS reads (no rules; mirror fastnw.py) ----
  counts(owner: Int32Array) {
    const c = [0, 0, 0, 0, 0];
    for (const v of owner) c[v]++;
    return c;
  }

  legalMoves(owner: Int32Array, strength: Int32Array, adj: Adj) {
    const moves: Link[] = [];
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] !== 0 || strength[i] <= 1) continue;
      for (const j of adj[i]) if (owner[j] !== 0) moves.push([i, j]);
    }
    return moves;
  }

  // ---- primitives (mutate owner/strength in place, like the Python client) ----
  checkWinner(owner: Int32Array) {
    this._put(this._owner, owner);
    return this.wasm.ext_check_winner(this._owner);
  }

  // Bot-turn cursor (mirrors the real game's OpponentAI loop): begin() snapshots
  // + sorts the faction's islands strongest-first, next() yields one attack at a
  // time — after a capture the bot continues with the stack it just moved. Call
  // next() only with the previous attack already resolved.
  botTurnBegin(owner: Int32Array, strength: Int32Array, faction: number): Ptr {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    const st = this.wasm.nw_malloc((MAXN + 3) * 4);
    this.wasm.bot_turn_begin(this._owner, this._strength, faction, st);
    return st;
  }

  // next attack as [frm, to], or null when the faction's attacks are done (then
  // free the cursor with botTurnEnd).
  botTurnNext(owner: Int32Array, strength: Int32Array, faction: number, st: Ptr): Link | null {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    let r = this.wasm.bot_turn_next(this._owner, this._strength, faction, st);
    if (r === 0) return null;
    r -= 1;
    return [r >> 8, r & 0xFF];
  }

  botTurnEnd(st: Ptr) { this.wasm.nw_free(st); }

  attackLogged(owner: Int32Array, strength: Int32Array, frm: number, to: number) {
    if (!this.isLegalAttack(owner, strength, frm, to)) throw new Error('illegal attack');
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    this.wasm.resolve_battle_logged(this._owner, this._strength, frm, to,
      this._flips, this._len, this._meta);
    this._getBack(this._owner, owner);
    this._getBack(this._strength, strength);
    const nflips = this.i32[this._len >> 2];
    const fbuf = this._get(this._flips, nflips);
    const flips = Array.from(fbuf, (v) => (v ? 'd' : 'a') as 'a' | 'd');
    const m = this._get(this._meta, 5);
    const meta = {
      captured: !!m[0], fromStart: m[1], toStart: m[2],
      fromStrength: m[3], toStrength: m[4],
    };
    return { flips, meta };
  }

  reinforce(owner: Int32Array, strength: Int32Array, faction: number) {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    this.wasm.ext_reinforce(this._owner, this._strength, faction);
    this._getBack(this._owner, owner);
    this._getBack(this._strength, strength);
  }

  // Replay without animation logs: the same engine primitives and real game dice.
  replayMove(owner: Int32Array, strength: Int32Array, move: Move) {
    if (!move.e && (!Array.isArray(move.a) || owner[move.a[0]] !== 0 ||
        !this.isLegalAttack(owner, strength, move.a[0], move.a[1])))
      throw new Error('illegal replay attack');
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    if (move.e) this.wasm.end_turn(this._owner, this._strength);
    else this.wasm.ext_resolve_battle(this._owner, this._strength, move.a[0], move.a[1]);
    this._getBack(this._owner, owner);
    this._getBack(this._strength, strength);
  }

  isLegalAttack(owner: Int32Array, strength: Int32Array, frm: number, to: number) {
    if (!Number.isInteger(frm) || !Number.isInteger(to) ||
        frm < 0 || to < 0 || frm >= owner.length || to >= owner.length) return false;
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    return !!this.wasm.ext_attack_legal(this._owner, this._strength, frm, to);
  }

  // ---- sweep-up (mop-up policy + its certificate; see engine/nw-core/src/policy.rs) ----
  // The rule the sweep plays, straight from the engine — the pages must not keep their own
  // copy, or the policy that gets certified stops being the policy that plays.
  sweepMove(owner: Int32Array, strength: Int32Array): MoveRef | null {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    const mv = this.wasm.sweep_best_move(this._owner, this._strength);
    return mv < 0 ? null : { from: mv >> 8, to: mv & 0xFF };
  }

  // Plays that policy to the end `trials` times on the private sim stream (the real
  // dice are untouched) and returns how many were LOST, giving up once that passes
  // maxLosses. Pass test: <= maxLosses. Costs about one search rollout per trial.
  sweepCertify(owner: Int32Array, strength: Int32Array, turns: number, trials: number, maxLosses = 0) {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    return this.wasm.sweep_certify(this._owner, this._strength, turns, trials, maxLosses);
  }

  // ---- search ----
  // Always rolls out on the private sim stream (seed it with useSim() first), never
  // the real mb32 game dice, so a preceding real-game battle can't leak into search.
  // `sims` is the floor; `maxSims` (default == sims => fixed budget) the ceiling.
  // maxSims > sims runs adaptively: keeps searching while the top two root moves
  // stay close, stops once the leader is uncatchable (move-identical to full).
  uctSearch(owner: Int32Array, strength: Int32Array, turns: number, sims: number, cPuct = 2.5, nroll = 1,
            maxSims = sims): RootStats {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    this.wasm.use_sim_rng();
    const nc = this.wasm.uct_search(this._owner, this._strength, turns, sims, maxSims, cPuct, nroll,
      this._acts, this._visits, this._q);
    if (nc < 0) throw new Error('uct_search pool alloc failed');
    const acts = this._get(this._acts, nc);
    const visits = this._get(this._visits, nc);
    const q = this.f64.slice(this._q >> 3, (this._q >> 3) + nc);
    return { acts, visits, q };
  }

  // ---- streaming search (persistent tree): begin once, then step/report in a
  // loop to visualize the root stats converging. Runs to the SAME terminal state
  // as uctSearch (bit-identical), just observed in chunks. Seed sim with useSim().
  uctBegin(owner: Int32Array, strength: Int32Array, turns: number, sims: number, cPuct = 2.5, nroll = 1,
           maxSims = sims) {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    this.wasm.use_sim_rng();
    const result = this.wasm.uct_begin(this._owner, this._strength, turns, sims, maxSims, cPuct, nroll);
    if (result < 0) throw new Error('uct_begin pool alloc failed');
    return result;
  }
  // Optional value-based early stop (off until set): settle once the leading move
  // has >= minVis visits AND its win-prob is decisive (<=lo or >=hi) or beats the
  // runner-up by >=gap. Verified offline: ~3x fewer sims/move, no winrate change.
  setValueStop(lo: number, hi: number, gap: number, minVis: number) { this.wasm.uct_set_value_stop(lo, hi, gap, minVis | 0); }
  // Grading mode: accurate comparison ACROSS root moves (root min-visit floor, no
  // dominance early-stops, second-half Q readout) instead of fastest best-move pick.
  // 0 = off (default, bit-identical search), 1 = on. STICKY — callers must reset.
  setGrade(mode: number) { this.wasm.uct_set_grade(mode | 0); }

  // run up to `budget` more sims; returns true when the search is finished.
  uctStep(budget: number) { return this.wasm.uct_step(budget | 0) !== 0; }
  uctSimsDone() { return this.wasm.uct_sims_done(); }
  // read current root children (acts/visits/q) without disturbing the tree.
  uctReport(): RootStats {
    const nc = this.wasm.uct_report(this._acts, this._visits, this._q);
    const acts = this._get(this._acts, nc);
    const visits = this._get(this._visits, nc);
    const q = this.f64.slice(this._q >> 3, (this._q >> 3) + nc);
    return { acts, visits, q };
  }
}
