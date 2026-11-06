#!/usr/bin/env bash
# Build the Rust engine:
#   ../src/nw_engine.wasm              the site's engine (committed: Workers Builds has
#                                      no Rust toolchain), loaded by src/fastnw.ts
#   target/release/libnw_engine.dylib  native C-ABI library (NW_ENGINE_SO for solver/fastnw.py)
#   target/c/fast_engine_nocontract.so the C engine built without FMA contraction,
#                                      the bit-identical reference for native parity checks
# Rust never contracts a*b+c into FMA and wasm has no FMA, so all three do the
# same IEEE arithmetic. After building, check with solver/validate_wasm.py.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release -p nw-abi
cargo build --release --target wasm32-unknown-unknown -p nw-abi
cp target/wasm32-unknown-unknown/release/nw_engine.wasm ../src/nw_engine.wasm
mkdir -p target/c
cc -O3 -ffp-contract=off -shared -fPIC ../solver/fast_engine.c -o target/c/fast_engine_nocontract.so
echo "built src/nw_engine.wasm ($(wc -c < ../src/nw_engine.wasm) bytes)"
