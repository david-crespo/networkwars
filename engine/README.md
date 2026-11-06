# Rust engine

`solver/fast_engine.c` in Rust: the whole engine and search, bit-identical to
the C built without FMA contraction (emcc `-O3`, or native clang
`-O3 -ffp-contract=off`), exporting the C ABI so every existing client, gate
and bench runs against it unchanged. The site still ships the C build
(`src/fast_engine.js`).

- `nw-core/`: the engine, no globals. `Engine` holds the topology, battle DP
  tables, both dice streams, and the search.
- `nw-abi/`: the C ABI (same names and signatures) over one global `Engine`;
  builds `libnw_engine.dylib` and `nw_engine.wasm`.
- `pkg/shim.mjs`: emscripten-shaped factory over the wasm, a drop-in for
  `src/fast_engine.js`. `pkg/use-rust-engine.mjs` is a node loader hook that
  redirects `src/fast_engine.js` to it, for gates that import it directly.

```sh
engine/build.sh    # native dylib, pkg/nw_engine.wasm, and the no-contraction C reference

# native parity + timing
uv run --project solver python solver/search_bench.py engine/target/c/fast_engine_nocontract.so engine/target/release/libnw_engine.dylib
NW_ENGINE_SO=$PWD/engine/target/release/libnw_engine.dylib uv run --project solver python solver/validate_fast.py
uv run --project solver python engine/time_native.py solver/fast_engine.so engine/target/release/libnw_engine.dylib

# wasm parity + timing
node solver/search_bench.mjs src/fast_engine.js engine/pkg/shim.mjs
node solver/latency_bench.mjs src/fast_engine.js engine/pkg/shim.mjs
node --import=$PWD/engine/pkg/use-rust-engine.mjs solver/worker_gate.mjs 40   # also wasm_gate, rules_worker_gate, yield_gate, review_gate
NODE_OPTIONS=--import=$PWD/engine/pkg/use-rust-engine.mjs uv run --project solver python solver/validate_wasm.py

# differential tests against the C reference (NW_C_ENGINE overrides the path)
(cd engine && cargo nextest run --release)
```

Clang contracts `a += b * c` into FMA by default (`-ffp-contract=on`), and
Rust never does, so the default `-O3` C build and this port pick different
moves occasionally; the `-ffast-math` build in `solver/` differs further.
Compare those by time per simulation only (`time_native.py`).
