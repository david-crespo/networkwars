import assert from 'node:assert/strict';
import { aiWinCurve, youWinCurve } from '../src/projections.ts';
import { REVIEW_VERSION, invalidateStaleReview, tierOf } from '../src/review.ts';
import { gradedWinProb, winProb } from '../src/calibration.ts';
import { skillHistory } from '../src/skill.ts';
const moves = [{ a: [0, 1] }, { e: 1 }, { e: 1 }, { e: 1 }];
const partial = { moves: [null, { turn: 1, bestQ: .95 }, { turn: 2, bestQ: .4 }, null] };
// Curves are calibrated win%, not raw Q.
assert.deepEqual(youWinCurve(partial, moves), [{ t: 1, q: null }, { t: 2, q: gradedWinProb(.4) }, { t: 3, q: null }]);
partial.moves[0] = { turn: 1, bestQ: .6 };
assert.equal(youWinCurve(partial, moves)[0].q, gradedWinProb(.6));
assert.deepEqual(aiWinCurve([{ a: [0, 1] }, { e: 1, q: .95 }, { e: 1, q: .4 }]),
  [{ t: 1, q: null }, { t: 2, q: winProb(.4) }]);
for (const table of [winProb, gradedWinProb]) {
  for (let q = 0; q < 1; q += .01) assert.ok(table(q + .01) >= table(q), 'calibration is monotone');
  assert.ok(table(.1) > .4 && table(0) < .02 && table(1) > .999);
}
// Stored old reviews with replay actions get requeued; compact old scores survive
// as historical data but must not enter comparisons against the corrected math.
const old = { rounds: [
  { you: { result: 'win', moves, review: { version: REVIEW_VERSION - 1 } } },
  { trim: true, you: { result: 'win', moves: [], review: { moves: [{ gap: 1, dead: false }] } } },
  { you: { moves, review: { version: REVIEW_VERSION, moves: [] } } },
  // Version 2 kept raw Qs: rescored in place, no search.
  { you: { result: 'lost', moves, review: { version: 2, n: 3, nLive: 3, meanLoss: 0, counts: [3, 0, 0, 0], moves: [
    { turn: 1, myQ: .1, bestQ: .3, gap: 20, dead: false },
    { turn: 1, myQ: .99, bestQ: .995, gap: .5, dead: false },
    { turn: 1, myQ: null, bestQ: .5, gap: null, dead: false }, null] } } },
  { trim: 1, you: { result: 'won', moves: [], review: { version: 2, moves: [{ gap: 3, dead: false }] } } },
] };
const restored = structuredClone(old);
restored.rounds.forEach(invalidateStaleReview);
assert.equal(restored.rounds[0].you.review, null);
assert.equal(restored.rounds[1].you.review.stale, true);
assert.equal(restored.rounds[1].you.review.moves[0].gap, 1);
assert.equal(restored.rounds[2].you.review.version, REVIEW_VERSION);
const v2 = restored.rounds[3].you.review;
assert.equal(v2.version, REVIEW_VERSION);
assert.ok(Math.abs(v2.moves[0].gap - 100 * (gradedWinProb(.3) - gradedWinProb(.1))) < 1e-3);
assert.equal(v2.moves[1].dead, true);
assert.equal(v2.moves[2].gap, null);
assert.equal(v2.nLive, 1);
const counts = [0, 0, 0, 0];
counts[tierOf(v2.moves[0].gap).k] = 1;
assert.deepEqual(v2.counts, counts);
assert.equal(restored.rounds[4].you.review.stale, true);
assert.deepEqual(skillHistory(restored.rounds).filter(g => g.value != null).map(g => g.ri), [3]);
console.log('PASS: turn-start projections, partial-review holes, review-version migration and preserved legacy data');
