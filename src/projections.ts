// One value at the first decision of each turn. Preserve missing values so a
// later post-battle estimate cannot slide back to the start of that turn.
import { gradedWinProb, winProb } from './calibration.ts';
import type { Move, Review } from './types.ts';

export interface CurvePoint { t: number; q: number | null }

function turnStartCurve(moves: Move[], valueAt: (k: number) => number | null | undefined) {
  const out: CurvePoint[] = [];
  let turn = 1;
  for (let k = 0; k < moves.length; k++) {
    if (out.at(-1)?.t !== turn)
      out.push({ t: turn, q: valueAt(k) ?? null });
    if (moves[k].e) turn++;
  }
  return out;
}

// Search Qs, calibrated to win%. AI values were recorded during play; human
// values come from the review's recommended move, representing the position
// before the recorded decision.
const win = (q: number | null | undefined, table: (q: number) => number) => q == null ? null : table(q);
export const aiWinCurve = (moves: Move[]) => turnStartCurve(moves, k => win(moves[k].q, winProb));
export const youWinCurve = (review: Review | null, moves: Move[]) =>
  turnStartCurve(moves, k => win(review?.moves[k]?.bestQ, gradedWinProb));
