// Workloads over a wasm build's raw exports (the C ABI), shared by node and the
// browser pages. Each returns elapsed ms plus a digest of every result, so builds
// can be checked for exact agreement wherever they run.

const buffers = x => Object.fromEntries(
  ['o', 's', 'x', 'y', 'acts', 'visits', 'q'].map(k => [k, x.nw_malloc(4096 * 8)]));
// Fresh views each time: a search can grow the memory.
const i32 = x => new Int32Array(x.memory.buffer);
const f64 = x => new Float64Array(x.memory.buffer);

// Fixed-budget searches from the openings and first few turns of `seeds` games, in
// play mode and grading mode.
export function searches(x, seeds = 6, sims = 4000) {
  const b = buffers(x);
  let ms = 0, total = 0, digest = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    x.new_game(seed, b.o, b.s, b.x, b.y);
    for (let turn = 1; turn <= 4; turn++) {
      if (x.ext_check_winner(b.o) >= 0) break;
      for (const grade of [0, 1]) {
        x.uct_set_grade(grade);
        x.set_sim_seed(0x12345678n);
        x.use_sim_rng();
        const start = performance.now();
        const nc = x.uct_search(b.o, b.s, turn, sims, sims, 2.5, 1, b.acts, b.visits, b.q);
        ms += performance.now() - start;
        total += x.uct_sims_done();
        for (let k = 0; k < nc; k++)
          digest = (Math.imul(digest, 31) + i32(x)[(b.acts >> 2) + k] * 7 + i32(x)[(b.visits >> 2) + k]
            + Math.floor(f64(x)[(b.q >> 3) + k] * 1e9)) | 0;
      }
      x.uct_set_grade(0);
      x.use_mb32_rng();
      x.end_turn(b.o, b.s);
    }
  }
  return { ms, sims: total, digest };
}

// Rollouts/sec: many ranked playouts from early positions on the sim stream.
export function rollouts(x, seeds = 12, per = 2000) {
  const b = buffers(x);
  let ms = 0, wins = 0;
  for (let seed = 1; seed <= seeds; seed++)
    for (let turn = 1; turn <= 3; turn++) {
      x.new_game(seed, b.o, b.s, b.x, b.y);
      for (let t = 1; t < turn; t++) x.end_turn(b.o, b.s);
      x.set_sim_seed(BigInt(seed * 7919 + turn));
      x.use_sim_rng();
      const start = performance.now();
      for (let r = 0; r < per; r++) wins += x.rollout(b.o, b.s, turn);
      ms += performance.now() - start;
    }
  return { ms, rollouts: seeds * 3 * per, wins };
}

// Tail latency: play whole `seeds` games with a `sims` search per RED decision
// (top-visit move, game dice), as engine/nw-core/examples/games.rs does natively.
export function games(x, seeds, sims = 2000) {
  const b = buffers(x);
  return seeds.map(seed => {
    const n = x.new_game(seed, b.o, b.s, b.x, b.y);
    let turn = 1, moves = 0, digest = 0, ms = 0, slowest = 0;
    const redLeft = () => i32(x).subarray(b.o >> 2, (b.o >> 2) + n).includes(0);
    while (x.ext_check_winner(b.o) < 0 && redLeft() && turn <= 300) {
      x.set_sim_seed(BigInt(seed) << 20n | BigInt(moves));
      x.use_sim_rng();
      const start = performance.now();
      const nc = x.uct_search(b.o, b.s, turn, sims, sims, 2.5, 1, b.acts, b.visits, b.q);
      const t = performance.now() - start;
      ms += t; slowest = Math.max(slowest, t);
      let act = -1, best = -1;
      for (let k = 0; k < nc; k++) {
        const v = i32(x)[(b.visits >> 2) + k];
        if (v > best) { best = v; act = i32(x)[(b.acts >> 2) + k]; }
      }
      x.use_mb32_rng();
      if (act < 0) { x.end_turn(b.o, b.s); turn++; }
      else x.ext_resolve_battle(b.o, b.s, act >> 8, act & 0xFF);
      moves++;
      digest = (Math.imul(digest, 31) + act) >>> 0;
    }
    return { seed, moves, ms, slowest, digest };
  });
}
