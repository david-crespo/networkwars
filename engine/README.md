# Rust engine

The whole engine and search, exporting a C ABI. The site runs its WASM build
(`src/nw_engine.wasm`, committed because Workers Builds has no Rust toolchain);
the native lab in `solver/` loads the native build. It began as a port of a C
engine (since removed) and its results are unchanged: the golden-trace tests
in `nw-abi/tests/traces.rs` freeze them.

- `nw-core/`: the engine, no globals. `Engine` holds the topology, battle DP
  tables, both dice streams, and the search.
- `nw-abi/`: the C ABI over one global `Engine`;
  builds `libnw_engine.dylib` and `nw_engine.wasm`, which `src/fastnw.ts`
  loads.

```sh
engine/build.sh    # src/nw_engine.wasm and the native dylib

# unit, ABI and golden-trace tests
(cd engine && cargo nextest run --release)

# native parity + timing (copy the previous dylib aside first)
uv run --project solver python solver/search_bench.py /tmp/before.dylib engine/target/release/libnw_engine.dylib
uv run --project solver python solver/validate_fast.py
uv run --project solver python engine/time_native.py /tmp/before.dylib engine/target/release/libnw_engine.dylib

# wasm: copy the committed build aside before changing the engine, then
node solver/search_bench.mjs /tmp/before.wasm src/nw_engine.wasm
node solver/latency_bench.mjs /tmp/before.wasm src/nw_engine.wasm

# speed: µs/sim on fixed searches in node, Chromium and WebKit (any .wasm builds)
node engine/bench/browser_bench.mjs node,chromium,webkit before=/tmp/before.wasm after=src/nw_engine.wasm
GAMES=108,374 node engine/bench/browser_bench.mjs node    # whole games: total and slowest search
(cd engine && cargo run --release --example bench)        # native µs/sim + digest
(cd engine && cargo run --release --example games -- 2000 108 374)
```
