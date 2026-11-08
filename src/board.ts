// Board renderer + battle/bot-turn animation for index.html (the duplicate-format
// head-to-head match) — the one place the game's LOOK lives: octagon nodes,
// coin-flip replay, reinforce flashes. (Originally shared with a free-play page,
// removed 2026-08-14.)
//
// It renders only; it holds no rules and drives no engine. The page owns the game
// state (the authoritative view from engine.worker.ts) and hands it here via
// setView(); the Board owns the canvas, the layout fit, and the transient
// decoration state that only exists during an animation (overrides / battle /
// flashId / reinforceFlash / animBoard).

import type { AttackEvent, Faction, GameView, MoveRef, NodeView, TurnEvent } from './types.ts';

interface Palette { rim: string; body: string; bloom: string; bloomY?: number; ink: string; attack: string[] }
type Point = { x: number; y: number }
type Rgb = number[]
interface Skin { cv: HTMLCanvasElement; size: number }
type SkinMode = 'idle' | 'halo' | 'attacker' | 'defender' | 'reinforce'

// Sampled from the recording at 5s (idle), 10.8/20/26/36/54s (attacking).
// Idle fills are intentionally not a fixed multiple of the rim: green and purple
// are darker. Keep text normal-width; the reference's compressed type is not used.
export const NODE_PALETTE: Record<Faction, Palette> = {
  red:    { rim:'#ff4a62', body:'#a93343', bloom:'#f895a3', ink:'#be192b', attack:['#ffdbe2','#ffa9b6','#ff99a8','#ff4a62'] },
  green:  { rim:'#0ed887', body:'#006b43', bloom:'#69c5a2', ink:'#00a060', attack:['#d9f9f2','#a6efdf','#97edd9','#0ad5a8'] },
  yellow: { rim:'#e2b200', body:'#967600', bloom:'#e9ce69', ink:'#a88600', attack:['#fff7d8','#ffeeab','#ffeb98','#ffda3f'] },
  blue:   { rim:'#3b90f1', body:'#2a5fa0', bloom:'#8cbbef', ink:'#105ab5', attack:['#d6e9fd','#a1cbf8','#90c3f7','#3b90f1'] },
  purple: { rim:'#ac64f8', body:'#582988', bloom:'#af87d9', bloomY:.90, ink:'#702dba', attack:['#f0e0ff','#d9b6fb','#d1a9fb','#ac64f8'] },
};
const BATTLE_GLOW: Record<Faction, string> = { red:'#ff2842', green:'#00d785', yellow:'#ffd62a', blue:'#2084f5', purple:'#a143ff' };
export const COLORS = Object.fromEntries(Object.entries(NODE_PALETTE).map(([f, p]) => [f, p.rim])) as Record<Faction, string>;
function tint(hex: string, white: number, alpha = 1) {
  const rgb = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
  return `rgba(${rgb.map(c => Math.round(c + (255-c)*white)).join(',')},${alpha})`;
}
export const ORDER: readonly Faction[] = ['red','green','yellow','blue','purple'];
export const SPEEDS = { instant: 0, fast: 0.25 };  // sleep-time multiplier

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// one of 8 compass arrows for the on-board direction of an attack (screen y grows downward)
const DIR_ARROWS = ['→','↗','↑','↖','←','↙','↓','↘'];
export function dirArrow(f: Point, t: Point) {
  const a = Math.atan2(-(t.y - f.y), t.x - f.x);   // up is positive
  const idx = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return DIR_ARROWS[idx];
}

// Classic timings follow the reference's distinct focus / attrition / settle beats.
// Fast scales every beat; Instant skips the entire replay, including queued frames.
// Casualty beats carry their overshoot past the last frame (see animateBattle), so
// theirs is the exact pace: 200 is 50ms at Fast, what Fast showed at 60Hz back
// when a 140 beat rounded up to three frames.
export const TIMING = Object.freeze({ focus: 240, casualty: 200, settle: 300,
  handoff: 220, reinforce: 520, gap: 100, arrow: 640 });
// Big stacks count down faster: the casualty pace is multiplied by this for the
// attacker's current count, so it starts fast and eases back to normal. About 1.2x
// at 10, 2x at 30, 3x at 50, 5x at 80; any battle from 30 up takes about a second.
export const stackBoost = (attacker: number) => 1 + (attacker / 30) ** 1.5;

function octagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 4;
    const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

// Nodes read as short octagonal prisms: the base sits on the node's layout point,
// where the links meet, and the top face (numeral, glow, hits, arrows) rises above it.
// Height grows logarithmically with strength and saturates, so a big stack stands
// taller without dominating the board.
const OCT_COS = Array.from({ length: 9 }, (_, i) => Math.cos(i * Math.PI / 4));
const OCT_SIN = Array.from({ length: 9 }, (_, i) => Math.sin(i * Math.PI / 4));
const rgbOf = (hex: string): Rgb => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
const mixRgb = (a: Rgb, b: Rgb, t: number) => a.map((c, i) => c + (b[i]-c)*t);
const css = (rgb: Rgb) => `rgb(${rgb.map(Math.round).join(',')})`;
export function nodeHeight(strength: number, r: number) {
  return strength > 0 ? r * LIFT * Math.min(1, Math.log2(1 + strength) / Math.log2(25)) : 0;
}
const LIFT = .42, MAX_R = 26;
const ARROW = '#effff8';

// Paint a tiny starting-board thumbnail (faction-colored dots laid out by x,y).
// Used by the per-seed scoreboard rows and the AI-progress badge.
export function drawThumb(cv: HTMLCanvasElement, nodes: { x: number; y: number; owner: Faction }[]) {
  const ctx = cv.getContext('2d')!, W = cv.width, H = cv.height, pad = 5;
  ctx.clearRect(0, 0, W, H);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
  const sx = (W - 2*pad) / Math.max(1, maxX - minX), sy = (H - 2*pad) / Math.max(1, maxY - minY);
  const s = Math.min(sx, sy), r = Math.max(1.4, s * 0.32);
  for (const n of nodes) {
    const x = pad + (n.x - minX) * s, y = pad + (n.y - minY) * s;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2);
    ctx.fillStyle = COLORS[n.owner] || '#888'; ctx.fill();
  }
}

/** A node during an animation: a copy the replay mutates. */
type AnimNode = NodeView

export class Board {
  cv: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  boardEl: HTMLElement
  state: GameView | null
  layout: { r: number; s: number; ox: number; oy: number }
  selected: number | null
  targetsFor: Map<number, Set<number>>
  hoverMove: Partial<MoveRef> | null
  bestMove: Partial<MoveRef> | null
  reviewColors: boolean
  pad: number
  overrides: Map<number, { strength: number; owner?: Faction }>
  battle: { from: number; to: number; elapsed?: number; clear?: number[] } | null
  flashId: number | null
  reinforceFlash: Set<number> | null
  animBoard: AnimNode[] | null
  light: number
  pulse: number
  onReplay: (faction: Faction, nodes: AnimNode[]) => void
  skins: Map<string, Skin>
  size: { width: number; height: number }
  positions: Point[]
  speed: number
  abort: boolean

  // canvas: the <canvas> to paint; boardEl: its sizing parent (measured on resize)
  constructor(canvas: HTMLCanvasElement, boardEl: HTMLElement) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.boardEl = boardEl;
    this.state = null;              // authoritative view from the worker
    this.layout = { r: 20, s: 1, ox: 0, oy: 0 };

    // ---- decorations the PAGE sets ----
    this.selected = null;           // selected red node id
    this.targetsFor = new Map();    // from -> Set(to), indexed from view.legalMoves
    this.hoverMove = null;          // {from,to} previewed on the grid
    this.bestMove = null;           // {from,to} a review's preferred move
    this.reviewColors = false;      // a review: the played move solid, the best dashed,
                                    // and no lit target as in the play preview
    this.pad = 38;                  // px kept clear around the board

    // ---- transient state owned by the animations ----
    this.overrides = new Map();     // nodeId -> {strength, owner?} mid-battle
    this.battle = null;             // {from,to} of the active fight
    this.flashId = null;
    this.reinforceFlash = null;     // Set(nodeId)
    this.animBoard = null;          // mutable node copy used while animating bot turns
    this.light = 0;                 // battle/reinforcement brightness, 0..1
    this.pulse = 0;                 // casualty / reinforcement pulse, 0..1
    this.onReplay = () => {};       // page updates faction counters at event boundaries
    this.skins = new Map();         // shaded/glowing sprites; no blur work per frame
    this.size = { width: 0, height: 0 };
    this.positions = [];

    this.speed = 1;                 // sleep multiplier (0 = instant, no replay)
    this.abort = false;             // set by the page to fast-forward a replay
  }

  get instant() { return this.speed === 0; }

  // Adopt a fresh authoritative view. Re-indexes legal moves and drops the
  // selection — every board change starts the next choice fresh.
  setView(v: GameView) {
    this.state = v;
    this.selected = null;
    this.hoverMove = null;
    this.bestMove = null;
    this.indexMoves();
    this.positions = v.nodes.map(n => this.nodePos(n));
  }

  indexMoves() {
    this.targetsFor = new Map();
    for (const m of (this.state?.legalMoves || [])) {
      if (!this.targetsFor.has(m.from)) this.targetsFor.set(m.from, new Set());
      this.targetsFor.get(m.from)!.add(m.to);
    }
  }

  // ---- layout ----
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const b = this.boardEl.getBoundingClientRect();
    this.size = { width: b.width, height: b.height };
    this.skins.clear();
    this.cv.width = b.width * dpr; this.cv.height = b.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.state) return;
    const maxX = Math.max(...this.state.nodes.map(n => n.x)) || 1;
    const maxY = Math.max(...this.state.nodes.map(n => n.y)) || 1;
    const pad = this.pad;
    // The top also keeps room for the tallest node's lift, and the board is centered
    // as it looks: from the tallest possible top face down to the bottom row's base.
    const topPad = pad + MAX_R * LIFT;
    const s = Math.min((b.width - pad*2) / maxX, (b.height - topPad - pad) / maxY);
    const r = Math.min(s * 0.34, MAX_R);
    this.layout = { r, s, ox: (b.width - maxX * s) / 2,
      oy: Math.max(topPad, (b.height - maxY * s + r * LIFT) / 2) };
    this.positions = this.state.nodes.map(n => this.nodePos(n));
    this.draw();
  }

  nodePos(n: Point): Point { return { x: this.layout.ox + n.x * this.layout.s, y: this.layout.oy + n.y * this.layout.s }; }

  // pointer distance to the node's column: anywhere from its base up to its top face
  _columnDist(n: NodeView, mx: number, my: number) {
    const p = this.nodePos(n), top = p.y - nodeHeight(n.strength, this.layout.r);
    return Math.hypot(mx - p.x, my - Math.min(p.y, Math.max(top, my)));
  }

  hitNode(mx: number, my: number) {
    if (!this.state) return null;
    for (const n of this.state.nodes)
      if (this._columnDist(n, mx, my) <= this.layout.r) return n;
    return null;
  }

  // forgiving drag target: the nearest node in `ids` within `slop` node-radii of
  // the pointer (drags end sloppily; the exact hit test is too strict a release)
  nearestOf(mx: number, my: number, ids: Iterable<number> | null | undefined, slop = 2.2) {
    if (!this.state || !ids) return null;
    let best: NodeView | null = null, bd = this.layout.r * slop;
    for (const id of ids) {
      const n = this.state.nodes[id]; if (!n) continue;
      const d = this._columnDist(n, mx, my);
      if (d <= bd) { bd = d; best = n; }
    }
    return best;
  }

  // The prism's visible walls, from the raised top face `p` down `h` to the ground:
  // four facets from angle 0 to π, shaded darker toward the right, brightening toward
  // the owner's rim while the node is lit.
  _drawWall(p: Point, h: number, owner: Faction, light: number) {
    const r = this.layout.r;
    if (h < .5) return;
    const ctx = this.ctx, palette = NODE_PALETTE[owner];
    const body = rgbOf(palette.body), rim = rgbOf(palette.rim), black = [0,0,0];
    for (let k = 0; k < 4; k++) {
      const x0 = p.x + r * OCT_COS[k], y0 = p.y + r * OCT_SIN[k];
      const x1 = p.x + r * OCT_COS[k+1], y1 = p.y + r * OCT_SIN[k+1];
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.lineTo(x1, y1 + h); ctx.lineTo(x0, y0 + h);
      ctx.closePath();
      ctx.fillStyle = css(mixRgb(mixRgb(body, black, .6 - .14 * k), rim, light * .55));
      ctx.fill();
    }
    ctx.beginPath();
    for (let k = 0; k <= 4; k++) {
      const x = p.x + r * OCT_COS[k], y = p.y + r * OCT_SIN[k] + h;
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    for (let k = 1; k < 4; k++) {
      const x = p.x + r * OCT_COS[k], y = p.y + r * OCT_SIN[k];
      ctx.moveTo(x, y); ctx.lineTo(x, y + h);
    }
    ctx.strokeStyle = css(mixRgb(rim, black, .3));
    ctx.lineWidth = Math.max(.8, r * .05); ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Paint the expensive bloom and shading once per size/faction/state. Animation
  // frames then composite sprites and numbers, without repeated canvas shadows.
  _skin(owner: Faction, mode: SkinMode = 'idle', glow = owner): Skin {
    const key = `${owner}:${mode}:${glow}`;
    const cached = this.skins.get(key);
    if (cached) return cached;
    const r = this.layout.r, size = Math.ceil(r * 4.6);
    const cv = document.createElement('canvas'), dpr = window.devicePixelRatio || 1;
    cv.width = cv.height = Math.ceil(size * dpr);
    const ctx = cv.getContext('2d')!; ctx.scale(dpr, dpr);
    const c = size / 2, palette = NODE_PALETTE[owner], idle = mode === 'idle';
    // Keep the halo close to the rim and subdued; combat still reads brighter.
    // A gradient keeps its size consistent at any DPR.
    const glowColor = idle ? COLORS[glow] : BATTLE_GLOW[glow];
    const haloRadius = 1.42;
    const halo = ctx.createRadialGradient(c,c,0,c,c,r*haloRadius);
    const falloff = idle ? [[0,.35],[1,.25],[1.1,.12],[1.2,.035],[1.3,0],[haloRadius,0]]
      : [[0,.7],[1,.65],[1.12,.38],[1.24,.14],[1.34,.035],[haloRadius,0]];
    for (const [radius, alpha] of falloff) halo.addColorStop(radius/haloRadius, tint(glowColor,0,alpha));
    ctx.fillStyle = halo; ctx.fillRect(0,0,size,size);
    if (mode === 'halo') {
      ctx.globalCompositeOperation = 'destination-out';
      octagon(ctx,c,c,r); ctx.fillStyle = '#000'; ctx.fill();
      const skin = { cv, size }; this.skins.set(key,skin); return skin;
    }
    octagon(ctx, c, c, r);
    if (idle) {
      ctx.fillStyle = palette.body;
    } else {
      const body = ctx.createLinearGradient(0, c-r, 0, c+r);
      if (mode === 'attacker') {
        body.addColorStop(0, tint(palette.rim, .94));
        for (const [i, stop] of [.2,.5,.65,1].entries())
          body.addColorStop(stop, palette.attack[i]);
      } else {
        // Defenders and reinforced nodes remain saturated, with pale light at
        // the top and bottom. This is distinct from the paler attacking stack.
        for (const [stop, white] of [[0,.86],[.2,.60],[.5,.24],[.65,.10],[.9,.44],[1,.22]])
          body.addColorStop(stop, tint(palette.rim, white));
      }
      ctx.fillStyle = body;
    }
    ctx.fill();
    if (idle) {
      // Localized soft light inside the lower face, not a whole-body gradient.
      ctx.save(); ctx.clip();
      ctx.translate(c, c + (palette.bloomY || .875)*r); ctx.scale(.85*r, .62*r);
      const bloom = ctx.createRadialGradient(0,0,0,0,0,1);
      bloom.addColorStop(0, palette.bloom);
      bloom.addColorStop(.2, palette.bloom);
      bloom.addColorStop(.55, tint(palette.bloom, 0, .45));
      bloom.addColorStop(1, tint(palette.bloom, 0, 0));
      ctx.fillStyle = bloom; ctx.fillRect(-1,-1,2,2);
      ctx.restore();
    }
    octagon(ctx, c, c, r * .95);
    ctx.lineJoin = 'round';
    ctx.lineWidth = idle ? Math.max(2, r * .13) : Math.max(.8, r * .045);
    ctx.strokeStyle = palette.rim; ctx.stroke();
    if (!idle) {
      // A fine white outside rim, with the owner's color retained inside it.
      octagon(ctx, c, c, r * .98);
      ctx.lineWidth = Math.max(.8, r * .045);
      ctx.strokeStyle = '#f5fff9'; ctx.stroke();
    }
    const skin = { cv, size }; this.skins.set(key, skin); return skin;
  }

  // Arrow rides the link itself (ground point to ground point), between the two
  // prisms: each end clears the node's base and its raised top face (h1/h2), so it
  // never covers a numeral. Static move previews sit at the target end; battles
  // supply a looping clock and the arrow eases along and fades at both ends of the
  // loop, so the restart never shows as a jump.
  _drawArrow(p1: Point, p2: Point, color: string, progress: number | null = null, h1 = 0, h2 = 0, alpha = 1) {
    const ctx = this.ctx, r = this.layout.r, R = r + 1;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;          // unit p1->p2
    const px = -uy, py = ux;                      // perpendicular
    // distance along the link from a ground point (direction with y-component dirY)
    // to where it leaves a radius-R disc around the top face, h above the ground
    const clear = (h: number, dirY: number) => Math.max(R, -dirY * h + Math.sqrt(Math.max(0, R*R - h*h * (1 - dirY*dirY))));
    const c1 = clear(h1, uy), c2 = clear(h2, -uy);
    const gap = len - c1 - c2;
    if (gap <= 0) return;
    const ah = Math.min(Math.max(5, r * .45), gap * .45);
    const aw = Math.min(Math.max(3, r * .25), ah * .7);
    let t = 1;
    if (progress !== null) {
      t = .5 - .5 * Math.cos(Math.PI * progress);  // ease in-out
      alpha *= Math.sin(Math.PI * progress);       // fade in and out each loop
    }
    if (alpha <= .01) return;
    const travel = c1 + ah + (gap - ah) * t;
    const tipX = p1.x + ux * travel, tipY = p1.y + uy * travel;
    const bx = tipX - ux * ah, by = tipY - uy * ah;
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(bx + px * aw, by + py * aw);
    ctx.lineTo(bx - px * aw, by - py * aw);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.fill();
    ctx.restore();
  }

  draw() {
    const state = this.state;
    if (!state) return;
    const ctx = this.ctx, layout = this.layout;
    ctx.clearRect(0, 0, this.size.width, this.size.height);
    const nodes = this.animBoard || state.nodes;
    const pos = this.positions;
    if (pos.length !== nodes.length) return;
    const { battle, selected, hoverMove, bestMove, targetsFor } = this;
    const on = (m: Partial<MoveRef> | null, a: number, c: number) =>
      !!m && ((a === m.from && c === m.to) || (a === m.to && c === m.from));

    // links
    for (const [a, c] of state.links) {
      const inBattle = battle && ((a===battle.from && c===battle.to) || (a===battle.to && c===battle.from));
      const selHot = selected !== null && (
           (a===selected && targetsFor.get(selected)?.has(c))
        || (c===selected && targetsFor.get(selected)?.has(a)));
      const isHover = on(hoverMove, a, c), isBest = on(bestMove, a, c);
      ctx.beginPath();
      ctx.moveTo(pos[a].x, pos[a].y); ctx.lineTo(pos[c].x, pos[c].y);
      // an active fight draws a bright line in the ATTACKER's color (from-node owner)
      if (battle && inBattle) { const ac = COLORS[nodes[battle.from].owner] || COLORS.red;
        ctx.strokeStyle = ac; ctx.lineWidth = 4; ctx.setLineDash([]); ctx.shadowColor = ac; ctx.shadowBlur = 12; }
      else if (isHover) { ctx.strokeStyle = ARROW; ctx.lineWidth = 3.5; ctx.setLineDash([]); ctx.shadowColor = ARROW; ctx.shadowBlur = 12; }
      else if (selHot) { ctx.strokeStyle = COLORS.red; ctx.lineWidth = 4; ctx.setLineDash([]); ctx.shadowColor = COLORS.red; ctx.shadowBlur = 10; }
      else if (isBest) { ctx.strokeStyle = ARROW; ctx.lineWidth = 2.5; ctx.setLineDash([5, 4]); ctx.shadowColor = ARROW; ctx.shadowBlur = 8; }
      else { ctx.strokeStyle = 'rgba(70,220,165,.65)'; ctx.lineWidth = 0.85; ctx.setLineDash([1.5,2.5]); ctx.shadowBlur = 0; }
      ctx.stroke();
      if (inBattle) { ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(234,255,246,.4)'; ctx.lineWidth = 1; ctx.stroke(); }
    }
    ctx.setLineDash([]); ctx.shadowBlur = 0;

    // nodes: links meet at the ground (pos); everything that marks a node sits on its raised top
    const heights: number[] = [];
    for (const n of nodes) {
      const ov = this.overrides.get(n.id);
      const owner = (ov && ov.owner) ? ov.owner : n.owner;
      const strength = ov ? ov.strength : n.strength;
      const h = nodeHeight(strength, layout.r);
      const p = { x: pos[n.id].x, y: pos[n.id].y - h };
      heights[n.id] = h;
      const isAtk = battle && n.id === battle.from;
      const isDef = battle && n.id === battle.to;
      const isSel = n.id === selected || isAtk;
      const isTarget = isDef || (selected !== null && targetsFor.get(selected)?.has(n.id));
      // the target an attack preview points at: brightened and ringed in a white glow
      const isAim = !battle && !this.reviewColors && hoverMove?.to === n.id;
      const isRein = this.reinforceFlash && this.reinforceFlash.has(n.id);
      // Both combatants brighten; only legal targets get a quiet extra outline.
      // Dark numerals on pale fighting nodes match the recording's contrast flip.
      const active = isAtk || isDef || isRein;
      const light = active ? this.light : isSel || isAim ? .28 : 0;
      const pulse = isRein || n.id === this.flashId ? this.pulse : 0;
      const mode: SkinMode = isDef ? 'defender' : isRein ? 'reinforce' : 'attacker';
      const glow = battle && (isAtk || isDef) ? nodes[battle.from].owner : owner;
      const skin = this._skin(owner), lit = this._skin(owner, mode, glow);
      const size = skin.size; // fixed sprite: brightness and wall height change during replay
      this._drawWall(p, h, owner, light);
      ctx.drawImage(skin.cv, p.x-size/2, p.y-size/2, size, size);
      if (light > 0) {
        ctx.globalAlpha = light;
        ctx.drawImage(lit.cv, p.x-size/2, p.y-size/2, size, size);
        ctx.globalAlpha = 1;
      }
      if (pulse > 0 && light > 0) {
        ctx.globalAlpha = .15 * pulse * light;
        ctx.drawImage(this._skin(owner, 'halo', glow).cv, p.x-size/2, p.y-size/2, size, size);
        ctx.globalAlpha = 1;
      }
      if (isAim) {
        octagon(ctx, p.x, p.y, layout.r * 1.12);
        ctx.strokeStyle = ARROW; ctx.lineWidth = 2.5; ctx.shadowColor = ARROW; ctx.shadowBlur = 14;
        ctx.stroke(); ctx.shadowBlur = 0;
      } else if (isTarget && !isDef) {
        octagon(ctx, p.x, p.y, layout.r * 1.12);
        ctx.strokeStyle = 'rgba(236,255,249,.8)'; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.save();
      ctx.translate(p.x, p.y + 1);
      ctx.fillStyle = light > .55 ? NODE_PALETTE[owner].ink : '#fff';
      ctx.font = `700 ${Math.round(layout.r * .88)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(strength), 0, 0);
      ctx.restore();
    }

    // The battle arrow clears the tallest each column gets during the fight (fixed
    // up front), so the path doesn't shift as casualties shorten the stacks.
    if (battle && battle.elapsed != null && pos[battle.from] && pos[battle.to]) {
      const [hf, ht] = battle.clear
        ? battle.clear.map(st => nodeHeight(st, layout.r))
        : [heights[battle.from], heights[battle.to]];
      this._drawArrow(pos[battle.from], pos[battle.to], '#effff8',
        (battle.elapsed % TIMING.arrow) / TIMING.arrow, hf, ht, this.light);
    }

    // a review's preferred move, dashed white beside the played one
    if (bestMove?.from != null && bestMove.to != null && pos[bestMove.from] && pos[bestMove.to])
      this._drawArrow(pos[bestMove.from], pos[bestMove.to], ARROW, null,
        heights[bestMove.from], heights[bestMove.to], .7);
    // hovered suggestion: a directional arrow along the edge (drawn on top of nodes)
    if (hoverMove && hoverMove.from != null && hoverMove.to != null) {
      const pf = pos[hoverMove.from], pt = pos[hoverMove.to];
      if (pf && pt) this._drawArrow(pf, pt, ARROW, null,
        heights[hoverMove.from], heights[hoverMove.to]);
    }
  }

  // ---- animation ----

  // A single clock for all phases. Read speed every frame so changing to Instant
  // takes effect during a fight; use a timer fallback when a tab is backgrounded.
  // Starts `carry` ms in and returns how far it ran past `ms`.
  async _beat(ms: number, frame: (t: number) => void = () => {}, carry = 0) {
    let elapsed = carry, last = performance.now();
    if (this.abort || this.instant) return 0;
    frame(Math.min(1, elapsed / ms)); this.draw();
    while (elapsed < ms && !this.abort && !this.instant) {
      await new Promise<void>(resolve => {
        let raf = 0;
        const finish = () => { clearTimeout(timer); cancelAnimationFrame(raf); resolve(); };
        const timer = setTimeout(finish, 50);
        raf = requestAnimationFrame(finish);
      });
      const now = performance.now();
      const delta = (now - last) / (this.speed || 1); last = now;
      elapsed += delta;
      if (this.battle) this.battle.elapsed = (this.battle.elapsed || 0) + delta;
      frame(Math.min(1, elapsed / ms)); this.draw();
    }
    return elapsed - ms;
  }

  _clearAnimation() {
    this.overrides.clear(); this.battle = null; this.flashId = null;
    this.reinforceFlash = null; this.light = 0; this.pulse = 0;
  }

  // Human and bot attacks replay the SAME authoritative casualty log. No dice or
  // rules are simulated here. Commit both outcomes (including repels) before the
  // settle beat, and retain the local result until the page adopts its final view.
  async animateBattle(e: AttackEvent) {
    const ownsBoard = !this.animBoard;
    const anim = this.animBoard ??= this.state!.nodes.map(n => ({ ...n }));
    const { from, to, fromStart, toStart, flips } = e;
    let a = fromStart, d = toStart;
    try {
      this.battle = { from, to, elapsed: 0,
        clear: [Math.max(a, e.fromStrength), Math.max(d, e.toStrength)] };
      this.overrides.set(from, { strength: a });
      this.overrides.set(to, { strength: d });
      await this._beat(TIMING.focus, t => { this.light = t; });
      // Each beat hands its overshoot to the next, so the pace follows stackBoost
      // smoothly instead of snapping to whole frames (fast ones share a frame).
      let carry = 0;
      for (const f of flips) {
        if (this.abort || this.instant) break;
        const boost = stackBoost(a);
        if (f === 'd') { d--; this.flashId = to; } else { a--; this.flashId = from; }
        this.overrides.set(from, { strength: a });
        this.overrides.set(to, { strength: Math.max(d, 0) });
        carry = await this._beat(TIMING.casualty / boost, t => { this.pulse = 1 - t; }, carry);
      }
      this.overrides.clear();
      anim[from].strength = e.fromStrength;
      anim[to].strength = e.toStrength;
      if (e.captured) anim[to].owner = e.attacker;
      this.flashId = e.captured ? to : from;
      this.onReplay(e.attacker, anim);
      await this._beat(TIMING.settle, t => { this.light = 1 - t; this.pulse = 1 - t; });
    } finally {
      this._clearAnimation();
      if (ownsBoard) this.animBoard = null;
    }
  }

  // The working board and header advance together, only at event boundaries.
  async animateEndTurn(res: { events: TurnEvent[] }) {
    const anim = this.animBoard = this.state!.nodes.map(n => ({ ...n }));
    this.selected = null; this.hoverMove = null;
    let curFaction: Faction | null = null;
    try {
      for (const ev of res.events) {
        if (this.abort || this.instant) break;
        const faction = ev.type === 'reinforce' ? ev.faction : ev.attacker;
        if (faction !== curFaction) {
          curFaction = faction;
          this.onReplay(faction, anim);
          await this._beat(TIMING.handoff);
        }
        if (ev.type === 'reinforce') {
          this.reinforceFlash = new Set(ev.changes.map(c => c.id));
          await this._beat(TIMING.focus, t => { this.light = t; });
          for (const ch of ev.changes) anim[ch.id].strength = ch.to;
          await this._beat(TIMING.reinforce, t => {
            this.light = 1 - t; this.pulse = Math.sin(Math.PI * t);
          });
          this._clearAnimation();
        } else {
          await this.animateBattle(ev);
        }
        await this._beat(TIMING.gap);
      }
    } finally {
      this._clearAnimation(); this.animBoard = null;
    }
  }
}
