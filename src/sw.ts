// Offline support without going stale. The page is fetched network-first (a
// deploy shows up on the next load; offline or a stalled connection falls back to
// the cached copy). Every file under assets/ has a content hash in its name and
// never changes, so it is served cache-first, from one cache per release. Each
// build pins RELEASE and PRECACHE below (vite.config.ts), which changes this
// file's bytes, so the browser installs the new worker and precaches the release.
const RELEASE: string = 'dev';   // vite.config.ts: the release id, also in the page's meta tag
const PRECACHE: string[] = [];   // vite.config.ts: the release's assets/ files

// A classic script, so `self` keeps the lib's generic worker type.
const sw = self as unknown as ServiceWorkerGlobalScope;

// CacheStorage is per origin, which may host other projects too.
const PREFIX = 'networkwars-';
const SHELL = `${PREFIX}shell`;
const CURRENT = `${PREFIX}${RELEASE}`;
const ROOT = new URL('./', sw.location.href).href;
const ASSETS = new URL('assets/', ROOT).pathname;
const NAV_TIMEOUT_MS = 3000;   // then serve the cached page rather than wait

sw.addEventListener('install', (event) => event.waitUntil((async () => {
  const page = await fetch(ROOT, { cache: 'no-cache' });
  if (!page.ok) throw new Error(`page: HTTP ${page.status}`);
  // A deploy landing mid-install serves a newer page than this worker's release;
  // fail and let the next navigation install the matching worker instead.
  if (!(await page.clone().text()).includes(`content="${RELEASE}"`))
    throw new Error('page and worker are from different releases');
  const shell = await caches.open(SHELL);
  await shell.put(ROOT, page);
  const icon = await fetch('favicon.svg', { cache: 'no-cache' }).catch(() => null);
  if (icon?.ok) await shell.put(new URL('favicon.svg', ROOT).href, icon);
  await (await caches.open(CURRENT)).addAll(PRECACHE);
  await sw.skipWaiting();
})()));

sw.addEventListener('activate', (event) => event.waitUntil((async () => {
  // Keep this release and the one before it (a tab opened before the deploy may
  // still start review workers from it); keys() lists caches in creation order.
  const older = (await caches.keys())
    .filter((k) => k.startsWith(PREFIX) && k !== SHELL && k !== CURRENT);
  await Promise.all(older.slice(0, -1).map((k) => caches.delete(k)));
  await sw.clients.claim();
})()));

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith(ASSETS)) return event.respondWith(cacheFirst(req));
  const navigate = req.mode === 'navigate';
  if (!navigate && !/\.(js|svg|html)$/.test(url.pathname)) return;
  event.respondWith(networkFirst(event, url.origin + url.pathname, navigate));
});

// Any release's cache will do: the name pins the content. Ignore Vary: the page
// loads its modules with crossorigin (an Origin header) but precaching does not.
async function cacheFirst(req: Request) {
  const hit = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await (await caches.open(CURRENT)).put(req, res.clone());
  return res;
}

function networkFirst(event: FetchEvent, key: string, navigate: boolean): Promise<Response> {
  let stored: Promise<void> | undefined;
  const network = fetch(event.request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      stored = caches.open(SHELL).then((c) => c.put(key, copy));
    }
    return res;
  });
  event.waitUntil(network.then(() => stored).catch(() => {}));
  const cached = async () => {
    const shell = await caches.open(SHELL);
    return (await shell.match(key)) || (navigate ? shell.match(ROOT) : undefined);
  };
  return new Promise((resolve) => {
    const timer = navigate ? setTimeout(() => cached().then((page) => page && resolve(page)),
      NAV_TIMEOUT_MS) : undefined;
    network.then(resolve, async () => resolve((await cached()) || Response.error()))
      .finally(() => clearTimeout(timer));
  });
}
