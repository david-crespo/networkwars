# Network Wars — project instructions

A faithful re-creation of the iOS game Network Wars, an MCTS AI that plays it, and a
static web page for duplicate-format head-to-head play against that AI, deployed on
Cloudflare. You are RED against four deterministic bots on a 30-node graph; the first
faction to 24 nodes wins. The rules (deal, battle, bots, army placement) were recovered
by decompiling the shipped IPA.

## Layout

- `engine/`: the only rules and search implementation (Rust). `nw-core/src` has
  `board_gen.rs`, `battle.rs`, `rules.rs`, `policy.rs` (C1 rollout and sweep-up),
  `search.rs`, `rng.rs`, `topology.rs`; `nw-abi` has the `extern "C"` exports.
- `src/nw_engine.wasm`: the engine built for the browser, committed because Workers
  Builds has no Rust toolchain.
- `src/`: the page (TypeScript, Vite). `main.ts` has the model, persistence, AI and review
  pumps, and rendering; `engine.worker.ts` holds game state and serves the `/api/*` routes
  in a Web Worker; `fastnw.ts` marshals the WASM exports; `board.ts` draws and animates
  the board; `review.ts` scores decisions; `skill.ts` and `projections.ts` compute the
  skill comparison and win% curves; `replay.ts` caches inspector trajectories; `types.ts`
  has the shared shapes; `sw.ts` is the service worker.
- `solver/`: the Python lab, the node gates and most docs. Python is for scripting and
  analysis (process pools, stats, fits) and implements no rules. `fastnw.py` loads
  `engine/target/release/libnw_engine.dylib` via ctypes (`NW_ENGINE_SO` overrides);
  `network_wars.py` is an object shim over it; `fmcts.py`, `par_eval.py` and `hard_ab.py`
  run self-play and paired A/B evals.
- `e2e/`: Playwright tests against the built site.

## Build and test

```sh
engine/build.sh                          # src/nw_engine.wasm + native dylib
(cd engine && cargo nextest run --release)
solver/check.sh                          # all gates; read it for the current list
npm run dev                              # no service worker in dev
npm run typecheck
npm run test:e2e                         # not part of check.sh
uv run --project solver python solver/par_eval.py --games 1000 --sims 8000
```

Workers Builds deploys every push to `main` (`wrangler.jsonc`, serving `dist/`).

- After any engine change, run `engine/build.sh` and commit `src/nw_engine.wasm`.
- Don't run `cargo fmt` on engine sources without rebuilding and committing the wasm:
  reformatting shifts line numbers in the wasm's panic messages, which changes the binary.
- `engine/nw-abi/tests/traces.rs` has golden digests of everything observable through
  the ABI. A moved digest means the game or search changed; update it only when that is
  intended, and say so in the commit. To find where two revisions diverge, set
  `NW_TRACE_DIR`, run both, and diff the dumps.
- `solver/page_slice.mjs` cuts code out of `src/main.ts` between marker strings (function
  headers, section comments) for `skill_gate.mjs` and `review_scheduler_gate.mjs`.
  Renaming a marker breaks those gates.

## Docs

- `DESIGN.md`: the rules in prose, the reference for what the game is.
- `solver/RULES_AUDIT.md`: rules compared against the original binary, rules versions,
  and what remains approximate.
- `solver/REAL_BATTLE_DECOMPILED.md`, `REAL_BOT_DECOMPILED.md`, `MAP_DEAL_DECOMPILED.md`:
  how battle, bot turns and the deal were recovered.
- `solver/MATH_AUDIT.md`: search and projection math, corrections and caveats.
- `solver/SWEEP_UP.md`: why sweep-up uses a policy certificate.
- `solver/REVIEW_PERFORMANCE.md`: review speed and accuracy.
- `solver/SEARCH_VARIANTS.md`, `solver/HARD_SET.md`: search experiments and the hard-opening benchmark.
- `solver/NODE_VISUAL_REFERENCE.md`: node colors sampled from the original game.
- `engine/README.md`, `solver/README.md`: the engine and the lab in depth, with bench commands.

## Engine invariants

- **Faithful rules.** Battle is the decompiled fair-coin attrition loop, with no fitted
  parameters; bots are the decompiled `OpponentAIOriginal`, with no RNG in move choice.
  Check `DESIGN.md` and the decompiled docs before changing either.
- **Rules versions.** New games use rules 2; unversioned saved rounds are rules 1
  (`new_game_legacy`). Pass a round's version through every replay path (resume, AI
  completion, review, inspector): saved actions replayed on the other generator's board
  silently become a different game.
- **Two dice streams.** The game uses mulberry32; the search rolls out on a private
  splitmix64 stream, so searching never changes the game or sees its future dice.
- **Rejected actions are free.** An illegal attack, or any action on a finished game, is
  refused without consuming dice. A zero-army defender stays owned and is a valid target.
- **Grading mode** (`uct_set_grade`, the search request's `grade` flag) is for grading
  human moves only, never for play. It spreads the budget across root moves for accurate
  comparison instead of finding the best move fast. The engine flag is sticky, so the
  worker clears it on every exit.
- **Bot turns run step by step** through `bot_turn_begin/next` so the page can animate
  each attack; the result must stay bit-identical to the atomic `end_turn`.
- An AlphaZero-style trained network was tried and plateaued below pure MCTS.

## Worker contract

`engine.worker.ts` serves HTTP-style routes over postMessage: `POST /api/game`
(`{seed, rules}`); `GET`/`DELETE /api/game/:id`; `POST /api/game/:id/` + `attack`
(`{from, to}`), `end-turn`, `search` (`{sims, maxSims, tag, grade}`), `sweep-check`
(`{trials, maxLosses}`); and `POST /api/replay` (`{seed, rules, moves}`, all frames in one
pass). `/load-board` is for `rules_worker_gate.mjs` only. Failures come back as `{error}`.
`solver/worker_gate.mjs` drives the routes the way the page does.

- **One worker per role.** The worker serves requests in order and aborts an in-flight
  search when a request queues behind it. The player, the AI and the review pool
  therefore have separate workers; sharing would let a tap truncate the AI's or a
  grader's search. The player's worker never searches.
- **Yield on timers, never MessageChannel.** WebKit routes MessagePorts through a process
  iOS kills in the background, after which a search awaiting a port hangs forever.
  Enforced by `solver/yield_gate.mjs`.
- **The game ends when RED has 0 nodes.** Attacks launch only from owned nodes, so a wiped
  RED could otherwise only press End Turn while the bots race to 24.
- Each `new Worker` gets its own URL (`?n=N`): WebKit shares one script load between
  workers started together and leaves the second outside the service worker, which
  breaks offline starts.

## The page

- **Duplicate format.** You play a seed blind while the AI plays the same seed in its own
  worker. The seed fixes the board and the dice stream, removing the deal variance that
  dominates unpaired win rates; once moves diverge, the two games draw different coins.
  A loss opens its analysis automatically, with the next seed dealt underneath.
  Forfeit Seed (menu) records a loss without finishing the game, marked `forfeit` on
  your side; the AI still plays the seed.
- **AI pump** (`nextAiSeed`): the inspected or just-finished pair first, then newest to
  oldest. It switches seeds only between complete moves, resumes saved actions without
  re-searching, and parks a seed it can't play in `aiErr` instead of throwing.
- **Review** (`review.ts`): grading-mode searches of every position you faced, 16k floor
  and 24k ceiling (only forced moves stop at the floor). A decision is excluded only when
  both the best and the played Q sit in the same extreme band (≤2% or ≥98%), so throwing
  away a won game still counts. Bump `REVIEW_VERSION` when grading results change. The
  page drops the pool to one lane while the AI plays, so grading doesn't starve it, and
  never to zero, so an open analysis keeps progressing.
- **Sweep-up** (opt-in): auto-plays a won game with the engine's mop-up policy. The offer
  is gated on a Monte-Carlo certificate of that policy, not on a search win%, which
  measures how the search would play and can't tell 99% from 100%. A playout that stalls
  at the turn limit counts as a loss, because the mop-up never takes an even fight. Every
  swept action re-certifies and hands the game back on failure. The offer sits in the
  footer so it never covers the board. See `SWEEP_UP.md`.
- **Persistence** is localStorage under `SAVE_CAP`, below Safari's quota. `trimOldest`
  strips replay detail from the oldest finished pairs and keeps results and review gaps.
  Unscored pairs may lose labels and history but must keep their action sequences, or
  they can never be graded and sit in the backlog forever. Failed saves are reported.
- **Errors.** A phone has no console, so errors, worker failures, stalled requests and
  failed saves go through `reportError` to the menu's Errors panel. Save Data (JSON)
  exports the tally with a diagnostics block for debugging a device offline.
- Each of your moves records commit time `t` and think time `ms`, never shown in the UI.

## UI conventions

- Red, green, yellow, blue and purple are faction colors. Don't use them for anything
  else (charts, badges, highlights).
- The header shows "Seed N", the You/AI W-L tally, and a dot that pulses while the AI
  plays (nothing more about its game, which would spoil your seed). Under it are the five
  node counts, each in a box of its faction's color.
- The board keeps the original octagon-prism look, all in `board.ts`. A flat redesign was
  tried and rejected.
- Keep the skill panel minimal: the chart, the zoom chips and one numeric legend. No
  explanatory prose, verdicts, coverage notices or status text.
