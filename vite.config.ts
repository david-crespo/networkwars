import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig, transformWithOxc, type Plugin } from 'vite'

// Every built file under assets/ has a content hash in its name, so a hash of the
// names identifies the release: the page reads it from a meta tag, and the service
// worker gets it with the list of files to precache.
const releaseOf = (files: string[]) =>
  createHash('sha256').update(files.sort().join('\n')).digest('hex').slice(0, 16)

const assetsIn = (bundle: Record<string, unknown>) =>
  Object.keys(bundle).filter((f) => f.startsWith('assets/'))

/** Emit src/sw.js as /sw.js (its scope must cover the page), pinned to this release. */
function serviceWorker(): Plugin {
  return {
    name: 'nw-service-worker',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (_, ctx) => [{
        tag: 'meta',
        attrs: { name: 'release', content: releaseOf(assetsIn(ctx.bundle ?? {})) },
        injectTo: 'head',
      }],
    },
    async generateBundle(_, bundle) {
      const precache = assetsIn(bundle)
      const source = readFileSync('src/sw.js', 'utf8')
        .replace(/^const RELEASE = null;/m, `const RELEASE = ${JSON.stringify(releaseOf(precache))};`)
        .replace(/^const PRECACHE = \[\];/m, `const PRECACHE = ${JSON.stringify(precache)};`)
      const { code } = await transformWithOxc(source, 'sw.js')
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code })
    },
  }
}

export default defineConfig({
  plugins: [serviceWorker()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
