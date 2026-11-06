#!/usr/bin/env bash
# Build the Rust engine:
#   target/release/libnw_engine.dylib  native C-ABI library (NW_ENGINE_SO for solver/fastnw.py)
#   pkg/nw_engine.wasm                 browser/node build, loaded by pkg/shim.mjs
#   target/c/fast_engine_nocontract.so the C engine built without FMA contraction,
#                                      the bit-identical reference for native parity checks
# Rust never contracts a*b+c into FMA and wasm has no FMA, so all three do the
# same IEEE arithmetic as the emcc build (src/fast_engine.js).
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release -p nw-abi
cargo build --release --target wasm32-unknown-unknown -p nw-abi
cp target/wasm32-unknown-unknown/release/nw_engine.wasm pkg/nw_engine.wasm
mkdir -p target/c
cc -O3 -ffp-contract=off -shared -fPIC ../solver/fast_engine.c -o target/c/fast_engine_nocontract.so
echo "built pkg/nw_engine.wasm ($(wc -c < pkg/nw_engine.wasm) bytes)"
