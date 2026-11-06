// The data the page, the workers and the saved tally share. Types only: nothing
// here exists at runtime.

export type Faction = 'red' | 'green' | 'yellow' | 'blue' | 'purple'

// ---- engine.worker.ts replies ----

/** Any worker reply can be an error instead. */
export interface Reply {
  error?: string
  _status?: number
}

export interface NodeView {
  id: number
  x: number
  y: number
  owner: Faction
  strength: number
}

export interface MoveRef {
  from: number
  to: number
}

export interface AttackEvent {
  type: 'attack'
  attacker: Faction
  from: number
  to: number
  captured: boolean
  fromStart: number
  toStart: number
  fromStrength: number
  toStrength: number
  /** Who lost each coin flip, in order: the attacker or the defender. */
  flips: ('a' | 'd')[]
}

export interface ReinforceEvent {
  type: 'reinforce'
  faction: Faction
  changes: { id: number; to: number }[]
}

export type TurnEvent = AttackEvent | ReinforceEvent

export interface GameView extends Reply {
  id: string
  seed: number | null
  nodes: NodeView[]
  links: [number, number][]
  counts: Record<Faction, number>
  turn: number
  legalMoves: MoveRef[]
  over: boolean
  youWon: boolean
  winner: Faction | null
  rules: number
  /** An attack's battle. */
  log?: AttackEvent[]
  /** An end turn's reinforcements and bot attacks. */
  events?: TurnEvent[]
}

export interface RankedMove {
  /** -1 = end turn, else from << 8 | to. */
  action: number
  from: number | null
  to: number | null
  visits: number
  frac: number
  q: number
}

export interface SearchResult extends Reply {
  winexp: number | null
  visits: number
  top: RankedMove[]
  all?: RankedMove[]
  best: RankedMove | null
  sims?: number
  done?: boolean
}

export interface SweepCheck extends Reply {
  ok: boolean
  over?: boolean
  losses: number
  trials: number
  maxLosses: number
  /** The mop-up's next attack, or null to end the turn. */
  move?: MoveRef | null
}

/** A request to an engine worker, in the shape of an HTTP route. */
export type Api = <T extends Reply = GameView>(
  path: string,
  method?: string,
  body?: object | null,
) => Promise<T>

// ---- the saved tally ----

/** A node as it stood when a move was played: what a move label draws. */
export interface Pip {
  owner: Faction
  strength: number
  x: number
  y: number
}

export interface Label {
  f: Pip
  t: Pip
}

interface MoveTiming {
  /** Epoch ms when the move was committed (your moves). */
  t?: number
  /** Think time in ms (your moves, not swept ones). */
  ms?: number
  /** Played by the sweep-up. */
  sw?: 1
  /** The search's win estimate when the AI played it. */
  q?: number | null
}

export interface AttackMove extends MoveTiming {
  a: [number, number]
  e?: undefined
  l?: Label
}

export interface EndMove extends MoveTiming {
  e: 1
  a?: undefined
  l?: undefined
}

/** One RED decision. Replaying the list from the seed is bit-exact. */
export type Move = AttackMove | EndMove

/** Red power after each turn's RED actions. */
export interface HistPoint {
  t: number
  n: number
  s: number
}

/** A graded decision. Trimmed rounds keep only gap, dead and ms. */
export interface ReviewMove {
  gap: number | null
  dead: boolean
  ms?: number
  n?: number
  turn?: number
  isEnd?: boolean
  label?: Label | null
  bestLbl?: Label | 'end' | null
  myQ?: number | null
  bestQ?: number | null
}

export interface Review {
  version: number
  source?: string
  /** null = still being searched. */
  moves: (ReviewMove | null)[]
  partial?: { done: number; total: number }
  n?: number
  nLive?: number
  meanLoss?: number
  counts?: [number, number, number, number]
  stale?: boolean
}

export interface Side {
  result: 'won' | 'lost' | null
  turns: number
  red: number
  moves: Move[]
  hist: HistPoint[]
  review: Review | null
}

export interface StartNode {
  x: number
  y: number
  owner: Faction
  strength: number
}

export interface Round {
  seed: number
  /** Missing on rounds saved before rules versions existed. */
  rules?: number
  at?: number
  startNodes: StartNode[] | null
  you: Side
  ai: Side
  /** Replay detail removed to fit storage. */
  trim?: 1
  /** Labels and history removed, actions kept for grading. */
  lean?: 1
}

export interface Tally {
  rounds: Round[]
  idx: number
}
