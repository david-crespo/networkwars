// Skill is an estimate from the search, not an outcome or a win probability.
// Give each game equal weight so a long game cannot dominate the comparison.
import type { Round } from './types.ts';

export const COMPARE_GAMES = 20, TREND_GAMES = 10;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const variance = (xs: number[]) => xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1);

export type GameStatus = 'complete' | 'active' | 'failed' | 'queued'

/** One finished game's average loss per live decision, or why it has none yet. */
export interface SkillGame {
  ri: number
  status: GameStatus
  progress?: { done: number; total: number }
  count: number
  value: number | null
  /** The first live decision, to open the game at. */
  k: number
  canReplay: boolean
}

export function skillHistory(rounds: Round[], reviewing = new Set<number>(),
                             errors: Record<number, unknown> = {}): SkillGame[] {
  return rounds.flatMap((r, ri) => {
    if (!r.you.result) return [];
    const rv = r.you.review;
    const complete = !!rv && !rv.partial && !rv.stale;
    const live = (rv?.moves || []).flatMap((m, k) =>
      m && m.gap != null && Number.isFinite(m.gap) && !m.dead ? [{ gap: m.gap, k }] : []);
    const status: GameStatus | 'unavailable' = complete ? 'complete' : reviewing.has(ri) ? 'active'
      : !r.you.moves.length ? 'unavailable' : errors[ri] ? 'failed' : 'queued';
    if (status === 'unavailable') return [];
    return [{ ri, status, progress: rv?.partial, count: live.length,
      value: complete && live.length ? mean(live.map(m => m.gap)) : null,
      k: live[0]?.k ?? 0, canReplay: !r.trim && !!r.you.moves.length }];
  });
}

/** The latest games against the ones before, once both windows are fully scored. */
export type SkillComparison =
  | { state: 'early'; needed: number }
  | { state: 'incomplete' | 'few-live'; size: number; missing?: number }
  | { state: 'better' | 'worse' | 'unclear'; earlier: number; now: number; change: number; size: number;
      beforeN: number; recentN: number; first: number; middle: number; recentFirst: number; last: number }

export function skillComparison(history: SkillGame[]): SkillComparison {
  // Adjacent windows retain pending games, avoiding a bias toward early reviews.
  // Games whose replay data is gone have already been silently omitted.
  const size = Math.min(COMPARE_GAMES, Math.floor(history.length / 2));
  if (size < 10) return { state: 'early', needed: 20 - history.length };
  const games = history.slice(-2 * size);
  const missing = games.filter(g => g.status !== 'complete');
  if (missing.length) return { state: 'incomplete', size, missing: missing.length };
  const valuesOf = (gs: SkillGame[]) => gs.flatMap(g => g.value != null ? [g.value] : []);
  const before = valuesOf(games.slice(0, size)), recent = valuesOf(games.slice(size));
  if (before.length < 10 || recent.length < 10) return { state: 'few-live', size };
  const earlier = mean(before), now = mean(recent), change = earlier - now;
  // A conservative descriptive signal: small changes or changes within about
  // two standard errors of game-to-game variation are inconclusive. This isn't
  // a calibrated test of underlying skill (boards and search estimates vary).
  const margin = Math.max(0.5, 2 * Math.sqrt(variance(before) / before.length + variance(recent) / recent.length));
  return { state: change > margin ? 'better' : change < -margin ? 'worse' : 'unclear',
    earlier, now, change, size, beforeN: before.length, recentN: recent.length,
    first: games[0].ri + 1, middle: games[size - 1].ri + 1,
    recentFirst: games[size].ri + 1, last: games[games.length - 1].ri + 1 };
}

export function skillTrend(history: SkillGame[], zoom = Infinity) {
  const points = history.map((game, i) => {
    const window = history.slice(Math.max(0, i - TREND_GAMES + 1), i + 1);
    const values = window.flatMap(g => g.value != null ? [g.value] : []);
    return { ...game, trend: game.value != null && window.every(g => g.status === 'complete')
      && values.length ? mean(values) : null };
  });
  return Number.isFinite(zoom) ? points.slice(-zoom) : points;
}
