// The exports of fast_engine.c's WASM build (solver/build_wasm.sh). Pointers are
// byte offsets into the wasm heap; int32 arrays go through HEAP32.
type Ptr = number

export interface EngineModule {
  HEAP32: Int32Array
  HEAPF64: Float64Array
  _malloc(bytes: number): Ptr
  _free(ptr: Ptr): void

  _new_game(seed: number, owner: Ptr, strength: Ptr, x: Ptr, y: Ptr): number
  _new_game_legacy(seed: number, owner: Ptr, strength: Ptr, x: Ptr, y: Ptr): number
  _set_topology(n: number, adjOff: Ptr, adjList: Ptr): void
  _get_adj(adjOff: Ptr, adjList: Ptr): void
  _get_links(links: Ptr): number

  _set_rng_mb32(seed: number): void
  _get_rng_mb32(): number
  _set_sim_seed(seed: bigint): void
  _use_mb32_rng(): void
  _use_sim_rng(): void

  _ext_attack_legal(owner: Ptr, strength: Ptr, from: number, to: number): number
  _ext_check_winner(owner: Ptr): number
  _ext_reinforce(owner: Ptr, strength: Ptr, faction: number): void
  _ext_resolve_battle(owner: Ptr, strength: Ptr, from: number, to: number): void
  _resolve_battle_logged(owner: Ptr, strength: Ptr, from: number, to: number,
    flips: Ptr, len: Ptr, meta: Ptr): void
  _end_turn(owner: Ptr, strength: Ptr): void
  _bot_turn_begin(owner: Ptr, strength: Ptr, faction: number, cursor: Ptr): void
  _bot_turn_next(owner: Ptr, strength: Ptr, faction: number, cursor: Ptr): number
  _sweep_best_move(owner: Ptr, strength: Ptr): number
  _sweep_certify(owner: Ptr, strength: Ptr, turns: number, trials: number, maxLosses: number): number

  _uct_search(owner: Ptr, strength: Ptr, turns: number, sims: number, maxSims: number,
    cPuct: number, nroll: number, acts: Ptr, visits: Ptr, q: Ptr): number
  _uct_begin(owner: Ptr, strength: Ptr, turns: number, sims: number, maxSims: number,
    cPuct: number, nroll: number): number
  _uct_step(budget: number): number
  _uct_report(acts: Ptr, visits: Ptr, q: Ptr): number
  _uct_sims_done(): number
  _uct_set_value_stop(lo: number, hi: number, gap: number, minVisits: number): void
  _uct_set_grade(mode: number): void
}

export default function Module(): Promise<EngineModule>
