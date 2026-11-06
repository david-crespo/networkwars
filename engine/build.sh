#!/usr/bin/env bash
# Build the Rust engine:
#   ../src/nw_engine.wasm              the site's engine (committed: Workers Builds has
#                                      no Rust toolchain), loaded by src/fastnw.ts
#   target/release/libnw_engine.dylib  native C-ABI library, loaded by solver/fastnw.py
# Rust never contracts a*b+c into FMA and wasm has no FMA, so both do the same
# IEEE arithmetic. After building, check with solver/validate_wasm.py.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release -p nw-abi
cargo build --release --target wasm32-unknown-unknown -p nw-abi
cp target/wasm32-unknown-unknown/release/nw_engine.wasm ../src/nw_engine.wasm
echo "built src/nw_engine.wasm ($(wc -c < ../src/nw_engine.wasm) bytes)"
