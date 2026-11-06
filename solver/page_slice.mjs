// For gates that run some of the page's functions in a vm context with stubbed
// neighbors: the source of src/main.ts between two markers, types stripped.
import fs from 'node:fs';
import { transformWithOxc } from 'vite';

const page = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

export async function pageSlice(start, end) {
  const i = page.indexOf(start), j = page.indexOf(end, i);
  if (i < 0 || j < 0) throw new Error(`src/main.ts has no ${i < 0 ? start : end}`);
  return (await transformWithOxc(page.slice(i, j), 'slice.ts')).code;
}
