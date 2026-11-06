# Rust engine

`solver/fast_engine.c` in Rust: the whole engine and search, bit-identical to
the C built without FMA contraction (native clang `-O3 -ffp-contract=off`, or
emcc `-O3`), exporting the same C ABI. The site runs its WASM build
(`src/nw_engine.wasm`, committed because Workers Builds has no Rust toolchain),
about 1.9x faster than the C compiled to WASM. The native lab in `solver/`
still uses the C; a rules or search change goes in both.

- `nw-core/`: the engine, no globals. `Engine` holds the topology, battle DP
  tables, both dice streams, and the search.
- `nw-abi/`: the C ABI (same names and signatures) over one global `Engine`;
  builds `libnw_engine.dylib` and `nw_engine.wasm`, which `src/fastnw.ts`
  loads.

```sh
engine/build.sh    # src/nw_engine.wasm, the native dylib, and the no-contraction C reference

# differential tests against the C reference (NW_C_ENGINE overrides the path)
(cd engine && cargo nextest run --release)

# native parity + timing
uv run --project solver python solver/search_bench.py engine/target/c/fast_engine_nocontract.so engine/target/release/libnw_engine.dylib
NW_ENGINE_SO=$PWD/engine/target/release/libnw_engine.dylib uv run --project solver python solver/validate_fast.py
uv run --project solver python engine/time_native.py solver/fast_engine.so engine/target/release/libnw_engine.dylib

# wasm: copy the committed build aside before changing the engine, then
node solver/search_bench.mjs /tmp/before.wasm src/nw_engine.wasm
node solver/latency_bench.mjs /tmp/before.wasm src/nw_engine.wasm

# speed: µs/sim on fixed searches in node, Chromium and WebKit (any .wasm builds)
node engine/bench/browser_bench.mjs node,chromium,webkit before=/tmp/before.wasm after=src/nw_engine.wasm
GAMES=108,374 node engine/bench/browser_bench.mjs node    # whole games: total and slowest search
(cd engine && cargo run --release --example bench)        # native µs/sim + digest
(cd engine && cargo run --release --example games -- 2000 108 374)
```

Clang contracts `a += b * c` into FMA by default (`-ffp-contract=on`), and
Rust never does, so the default `-O3` C build and this port pick different
moves occasionally; the `-ffast-math` build in `solver/` differs further.
Compare those by time per simulation only (`time_native.py`).
