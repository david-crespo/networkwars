// Emscripten-shaped factory over the Rust WASM build (pkg/nw_engine.wasm), so
// src/fastnw.js and the solver/*.mjs benches load it in place of
// src/fast_engine.js unchanged: `await Module()` gives `_malloc`, `_free`,
// `HEAP32`, `HEAPF64` and `_<name>` for every C export.
const WASM_URL = new URL('./nw_engine.wasm', import.meta.url);

async function wasmBytes() {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises');
    return readFile(WASM_URL);
  }
  return (await fetch(WASM_URL)).arrayBuffer();
}

let compiled;

export default async function Module() {
  compiled ??= WebAssembly.compile(await wasmBytes());
  const instance = await WebAssembly.instantiate(await compiled, {});
  const x = instance.exports;
  // Memory can grow during a search; refresh the views when the buffer changes.
  let buffer, heap32, heapF64;
  const views = () => {
    if (buffer !== x.memory.buffer) {
      buffer = x.memory.buffer;
      heap32 = new Int32Array(buffer);
      heapF64 = new Float64Array(buffer);
    }
  };
  const M = {
    get HEAP32() { views(); return heap32; },
    get HEAPF64() { views(); return heapF64; },
    _malloc: x.nw_malloc,
    _free: x.nw_free,
  };
  for (const [name, value] of Object.entries(x)) {
    if (typeof value === 'function' && !name.startsWith('nw_')) M['_' + name] = value;
  }
  return M;
}
