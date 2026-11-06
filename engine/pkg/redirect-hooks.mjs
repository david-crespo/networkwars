// Module resolve hook for use-rust-engine.mjs.
const SHIM = new URL('./shim.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (resolved.url.endsWith('/src/fast_engine.js')) return { ...resolved, url: SHIM };
  return resolved;
}
