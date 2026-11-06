import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import { iphone18ProSafari } from './device'

// The board is a canvas, so the tests read node positions and game state through
// the page's read-only `window.__nw` hook.
declare global {
  interface Window {
    __nw: {
      board: any
      state: () => any
      locked: () => boolean
      model: () => { rounds: any[]; idx: number }
    }
  }
}

const errors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const seen: string[] = []
  errors.set(page, seen)
  page.on('pageerror', (e) => seen.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && seen.push(`console: ${m.text()}`))
  await page.addInitScript(() => localStorage.setItem('nwSpeed', 'instant'))
  await page.goto('/')
  await ready(page)
})

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([])
  // Everything the page reports to its Errors menu (worker failures, stalls, saves)
  const reported = await page.evaluate(() => JSON.parse(localStorage.getItem('nwErrors') || '[]'))
  expect(reported).toEqual([])
})

/** Wait until it's the player's move: a game is dealt and no move is animating. */
const ready = (page: Page) =>
  page.waitForFunction(() => window.__nw?.state() && !window.__nw.locked())

const current = (page: Page) =>
  page.evaluate(() => {
    const m = window.__nw.model()
    return { idx: m.idx, rounds: m.rounds.length, round: m.rounds[m.idx] }
  })

/** Tap a node: find a point on its column that hits it and nothing in front of it. */
async function tapNode(page: Page, id: number) {
  const pt = await page.evaluate((id) => {
    const { board } = window.__nw
    const n = board.state.nodes[id]
    const p = board.nodePos(n)
    const rect = board.cv.getBoundingClientRect()
    for (let dy = 0; dy < board.layout.r * 3; dy += 2)
      if (board.hitNode(p.x, p.y - dy)?.id === id) return { x: rect.left + p.x, y: rect.top + p.y - dy }
    return null
  }, id)
  expect(pt, `node ${id} is tappable`).not.toBeNull()
  await page.touchscreen.tap(pt!.x, pt!.y)
}

/** A legal attack for RED: [from, to]. */
const anyAttack = (page: Page) =>
  page.evaluate(() => {
    const [from, targets] = [...window.__nw.board.targetsFor.entries()][0]
    return [from, [...targets][0]] as [number, number]
  })

async function endTurn(page: Page) {
  const turn = await page.evaluate(() => window.__nw.state().turn)
  await page.locator('#endturn').tap()
  await page.waitForFunction(
    (turn) => { const s = window.__nw.state(); return s.over || (s.turn > turn && !window.__nw.locked()) },
    turn,
  )
}

const inViewport = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).boundingBox())!
  const vp = page.viewportSize()!
  expect(box, `${selector} on screen`).toBeTruthy()
  expect(box.x, `${selector} left edge`).toBeGreaterThanOrEqual(0)
  expect(box.y, `${selector} top edge`).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, `${selector} right edge`).toBeLessThanOrEqual(vp.width)
  expect(box.y + box.height, `${selector} bottom edge`).toBeLessThanOrEqual(vp.height)
}

test('the board fits the Safari viewport without scrolling', async ({ page }, info) => {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement!
    return { x: el.scrollWidth - innerWidth, y: el.scrollHeight - innerHeight }
  })
  expect(overflow).toEqual({ x: 0, y: 0 })
  for (const sel of ['#menu', '#mstrip', '#cv', '#bolt', '#endturn']) await inViewport(page, sel)

  // Every node, with its radius, is inside the canvas.
  const outside = await page.evaluate(() => {
    const { board } = window.__nw, r = board.layout.r
    const { width, height } = board.cv.getBoundingClientRect()
    return board.state.nodes
      .map((n: any) => ({ id: n.id, ...board.nodePos(n) }))
      .filter((p: any) => p.x - r < 0 || p.y - r < 0 || p.x + r > width || p.y + r > height)
  })
  expect(outside).toEqual([])
  await page.screenshot({ path: info.outputPath('board.png') })

  await page.locator('#menu').tap()
  await inViewport(page, '#menupop')
  await page.screenshot({ path: info.outputPath('menu.png') })
})

test('tapping a node then a target attacks it', async ({ page }) => {
  const [from, to] = await anyAttack(page)
  await tapNode(page, from)
  expect(await page.evaluate(() => window.__nw.board.selected)).toBe(from)
  await tapNode(page, to)
  await ready(page)
  const { round } = await current(page)
  expect(round.you.moves.map((m: any) => m.a)).toEqual([[from, to]])
})

test('the bolt toggles instant animations and remembers it', async ({ page }) => {
  const bolt = page.locator('#bolt')
  await expect(bolt).toHaveAttribute('aria-pressed', 'true') // the tests start on instant
  await bolt.tap()
  await expect(bolt).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate(() => [window.__nw.board.speed, localStorage.getItem('nwSpeed')]))
    .toEqual([0.2, 'fast'])
  await bolt.tap()
  expect(await page.evaluate(() => [window.__nw.board.speed, localStorage.getItem('nwSpeed')]))
    .toEqual([0, 'instant'])
})

test('animations default to fast', async ({ page, browser }) => {
  const context = await browser.newContext(iphone18ProSafari) // no stored setting
  const fresh = await context.newPage()
  await fresh.goto(page.url())
  await ready(fresh)
  await expect(fresh.locator('#bolt')).toHaveAttribute('aria-pressed', 'false')
  expect(await fresh.evaluate(() => window.__nw.board.speed)).toBe(0.2)
  await context.close()
})

test('reloading resumes the seed in progress', async ({ page }) => {
  const [from, to] = await anyAttack(page)
  await tapNode(page, from)
  await tapNode(page, to)
  await ready(page)
  await endTurn(page)
  const before = await current(page)
  const turn = await page.evaluate(() => window.__nw.state().turn)

  await page.reload()
  await ready(page)
  const after = await current(page)
  expect(after.round.seed).toBe(before.round.seed)
  expect(after.round.you.moves.map((m: any) => m.a ?? 'end'))
    .toEqual(before.round.you.moves.map((m: any) => m.a ?? 'end'))
  expect(await page.evaluate(() => window.__nw.state().turn)).toBe(turn)
})

test('the service worker serves the game offline', async ({ page, context, browserName }) => {
  // Playwright's WebKit fails an offline navigation before the service worker sees
  // it (the old Python-built site did too), so only Chromium can check this.
  test.skip(browserName === 'webkit', 'offline navigation is broken in Playwright WebKit')
  await page.waitForFunction(() => navigator.serviceWorker.controller)
  const seed = (await current(page)).round.seed
  await context.setOffline(true)
  await page.reload()
  await ready(page)
  expect((await current(page)).round.seed).toBe(seed)
  // Both engine workers loaded from the cache: the AI plays the seed offline too.
  await page.waitForFunction(() => window.__nw.model().rounds[0].ai.moves.length > 0)
})

test('Save Data then Load Data moves the tally to a fresh browser', async ({ page, browser }, info) => {
  await endTurn(page)
  await page.locator('#menu').tap()
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#mi-export').tap()])
  const file = info.outputPath('export.json')
  await download.saveAs(file)
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(exported.app).toBe('network-wars-h2h')

  const fresh = await browser.newContext(iphone18ProSafari)
  const other = await fresh.newPage()
  await other.goto(page.url())
  await ready(other)
  expect((await current(other)).round.seed).not.toBe(exported.tally.rounds[0].seed)
  other.on('dialog', (d) => d.accept())
  await other.locator('#menu').tap()
  const [chooser] = await Promise.all([other.waitForEvent('filechooser'), other.locator('#mi-import').tap()])
  await Promise.all([other.waitForEvent('load'), chooser.setFiles(file)])
  await ready(other)
  const loaded = await current(other)
  expect(loaded.round.seed).toBe(exported.tally.rounds[0].seed)
  expect(loaded.round.you.moves).toHaveLength(1)
  await fresh.close()
})

test('a finished game deals the next seed, then the AI and the review complete it', async ({ page }) => {
  test.setTimeout(5 * 60_000)
  // Ending every turn loses quickly (or gets RED wiped out).
  for (let i = 0; i < 200 && !(await page.evaluate(() => window.__nw.state().over)); i++)
    await endTurn(page)
  await page.waitForFunction(() => window.__nw.model().rounds.length === 2)
  const first = await page.evaluate(() => window.__nw.model().rounds[0])
  expect(first.you.result).toBe('lost')

  // A loss opens its analysis over the next seed.
  await expect(page.locator('#ov-seed')).toBeVisible()
  // The AI plays the same seed in its own worker, and the review scores every decision.
  await page.waitForFunction(() => window.__nw.model().rounds[0].ai.result, null, { timeout: 4 * 60_000 })
  await page.waitForFunction(() => {
    const rv = window.__nw.model().rounds[0].you.review
    return rv && !rv.partial
  }, null, { timeout: 4 * 60_000 })
  const review = await page.evaluate(() => window.__nw.model().rounds[0].you.review)
  expect(review.moves).toHaveLength(first.you.moves.length)
})
