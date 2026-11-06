#!/usr/bin/env bash
# Rebuild the engines and run the gameplay, search, replay, and UI gates.
set -euo pipefail
cd "$(dirname "$0")/.."

bash engine/build.sh
(cd engine && cargo nextest run --release)

for gate in validate_fast validate_wasm legacy_rules_gate; do
  uv run --project solver python "solver/$gate.py"
done

for gate in board projection skill review_scheduler rules_worker; do
  node "solver/${gate}_gate.mjs"
done
node solver/worker_gate.mjs 40
node solver/yield_gate.mjs
node solver/review_gate.mjs 11 4
npm run typecheck
npm run build
git diff --check
