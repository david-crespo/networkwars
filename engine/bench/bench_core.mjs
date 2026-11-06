// Engine-agnostic workloads over the raw module ABI (emscripten-shaped), shared by
// node and the browser pages. Each returns elapsed ms plus a digest of every result,
// so engines can be checked for exact agreement wherever they run.

const buffers = M => Object.fromEntries(
  ['o', 's', 'x', 'y', 'acts', 'visits', 'q'].map(k => [k, M._malloc(4096 * 8)]));

// Fixed-budget searches from the openings and first few turns of `seeds` games, in
// play mode and grading mode.
export function searches(M, seeds = 6, sims = 4000) {
  const b = buffers(M);
  let ms = 0, total = 0, digest = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    M._new_game(seed, b.o, b.s, b.x, b.y);
    for (let turn = 1; turn <= 4; turn++) {
      if (M._ext_check_winner(b.o) >= 0) break;
      for (const grade of [0, 1]) {
        M._uct_set_grade(grade);
        M._set_sim_seed(0x12345678n);
        M._use_sim_rng();
        const start = performance.now();
        const nc = M._uct_search(b.o, b.s, turn, sims, sims, 2.5, 1, b.acts, b.visits, b.q);
        ms += performance.now() - start;
        total += M._uct_sims_done();
        for (let k = 0; k < nc; k++)
          digest = (Math.imul(digest, 31) + M.HEAP32[(b.acts >> 2) + k] * 7 + M.HEAP32[(b.visits >> 2) + k]
            + Math.floor(M.HEAPF64[(b.q >> 3) + k] * 1e9)) | 0;
      }
      M._uct_set_grade(0);
      M._use_mb32_rng();
      M._end_turn(b.o, b.s);
    }
  }
  return { ms, sims: total, digest };
}

// Rollouts/sec: many ranked playouts from early positions on the sim stream.
export function rollouts(M, seeds = 12, per = 2000) {
  const b = buffers(M);
  let ms = 0, wins = 0;
  for (let seed = 1; seed <= seeds; seed++)
    for (let turn = 1; turn <= 3; turn++) {
      M._new_game(seed, b.o, b.s, b.x, b.y);
      for (let t = 1; t < turn; t++) M._end_turn(b.o, b.s);
      M._set_sim_seed(BigInt(seed * 7919 + turn));
      M._use_sim_rng();
      const start = performance.now();
      for (let r = 0; r < per; r++) wins += M._rollout(b.o, b.s, turn);
      ms += performance.now() - start;
    }
  return { ms, rollouts: seeds * 3 * per, wins };
}

// Tail latency: play whole `seeds` games with a `sims` search per RED decision
// (top-visit move, game dice), as engine/nw-core/examples/games.rs does natively.
export function games(M, seeds, sims = 2000) {
  const b = buffers(M);
  return seeds.map(seed => {
    const n = M._new_game(seed, b.o, b.s, b.x, b.y);
    let turn = 1, moves = 0, digest = 0, ms = 0, slowest = 0;
    const redLeft = () => M.HEAP32.subarray(b.o >> 2, (b.o >> 2) + n).includes(0);
    while (M._ext_check_winner(b.o) < 0 && redLeft() && turn <= 300) {
      M._set_sim_seed(BigInt(seed) << 20n | BigInt(moves));
      M._use_sim_rng();
      const start = performance.now();
      const nc = M._uct_search(b.o, b.s, turn, sims, sims, 2.5, 1, b.acts, b.visits, b.q);
      const t = performance.now() - start;
      ms += t; slowest = Math.max(slowest, t);
      let act = -1, best = -1;
      for (let k = 0; k < nc; k++) {
        const v = M.HEAP32[(b.visits >> 2) + k];
        if (v > best) { best = v; act = M.HEAP32[(b.acts >> 2) + k]; }
      }
      M._use_mb32_rng();
      if (act < 0) { M._end_turn(b.o, b.s); turn++; }
      else M._ext_resolve_battle(b.o, b.s, act >> 8, act & 0xFF);
      moves++;
      digest = (Math.imul(digest, 31) + act) >>> 0;
    }
    return { seed, moves, ms, slowest, digest };
  });
}
