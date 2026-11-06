// Swap the Rust WASM build in for src/fast_engine.js, without editing any
// importer: node --import ./engine/pkg/use-rust-engine.mjs solver/worker_gate.mjs
// (or NODE_OPTIONS="--import <abs path>" for gates that spawn node themselves).
import { register } from 'node:module';

register('./redirect-hooks.mjs', import.meta.url);
