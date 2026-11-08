#!/usr/bin/env python3
"""Fit the page's search-Q -> win% tables (src/calibration.ts).

`play` runs self-play at a fixed 6000 sims (most-visited move, the game's own dice),
recording the root Q of the chosen move at every decision. At one random decision
per game it also runs the page's two other searches: the AI's (6000 sims adaptive
to 150k, which is about 25x slower to play whole games with) and the review's
grading mode (16k-24k).

`fit` maps fixed-budget Q to the game's outcome: an isotonic (PAV) fit, then a
monotone PCHIP through the block centers, so neighboring Qs never share a flat step
and a small Q difference never reads as a zero gap. Longer searches read close
positions higher, so the AI's and the review's Qs each get a table through the
fixed-budget Q expected at that Q. It prints both tables, the current ones at a few
Qs with by-game bootstrap intervals, and how each table does at the sampled positions.

  uv run --project solver python solver/calibrate.py play --games 8000 --out calib.jsonl
  uv run --project solver python solver/calibrate.py fit calib.jsonl
"""
import argparse
import json
import pathlib
import re
import time
from multiprocessing import Pool

import numpy as np

import fastnw as F

# The page's AI budget (main.ts AI_SIMS, the worker's default ceiling) and the review's.
AI_SIMS, AI_MAX, REVIEW_SIMS, REVIEW_MAX = 6000, 150000, 16000, 24000
GRID = np.arange(101) / 100
TABLE_TS = pathlib.Path(__file__).resolve().parent.parent / 'src' / 'calibration.ts'


def search(o, s, t, sims, seed, grade=False, max_sims=None):
    F.use_sim(seed)
    F.set_grade(int(grade))
    try:
        a, v, q = F.uct_search(o, s, t, sims, return_q=True, max_sims=max_sims)
    finally:
        F.set_grade(0)
    j = int(np.argmax(v))
    return int(a[j]), float(q[j])


def play(seed):
    g = F.new_game(seed, 2)
    o, s, mb = g['owner'].copy(), g['strength'].copy(), g['mb']
    grade_at = int(np.random.default_rng(seed).integers(0, 30))
    t, dec, sample = 1, [], None
    while F.check_winner(o) < 0 and (o == 0).any() and t <= 300:
        sim = seed * 1009 + len(dec)
        a, q = search(o, s, t, AI_SIMS, sim)
        if len(dec) == grade_at:
            # The adaptive search shares the fixed one's first 6000 sims.
            sample = [len(dec), search(o.copy(), s.copy(), t, REVIEW_SIMS, seed * 7919 + 1, True, REVIEW_MAX)[1],
                      search(o.copy(), s.copy(), t, AI_SIMS, sim, max_sims=AI_MAX)[1]]
        dec.append(round(q, 4))
        F.set_mb32(mb)
        F._lib.use_mb32_rng()   # battles and bot turns draw the game's dice
        if a == -1:
            F.end_turn(o, s)
            t += 1
        else:
            F.resolve_battle(o, s, a >> 8, a & 0xFF)
        mb = F.get_mb32()
    return {'seed': seed, 'won': int(F.check_winner(o) == 0), 'turns': t, 'q': dec, 'sample': sample}


def pav(y):
    """Isotonic regression of y (already sorted by x): block means and sizes."""
    v, n = [], []
    for yi in y:
        v.append(float(yi)); n.append(1)
        while len(v) > 1 and v[-2] > v[-1]:
            v[-2] = (v[-2] * n[-2] + v[-1] * n[-1]) / (n[-2] + n[-1])
            n[-2] += n[-1]
            v.pop(); n.pop()
    return np.array(v), np.array(n)


def pchip(x, y, xs):
    """Fritsch-Carlson monotone cubic through (x, y), evaluated at xs."""
    h = np.diff(x); d = np.diff(y) / h
    m = np.zeros_like(y)
    m[0], m[-1] = d[0], d[-1]
    for k in range(1, len(x) - 1):
        if d[k - 1] * d[k] > 0:
            w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])
    i = np.clip(np.searchsorted(x, xs, side='right') - 1, 0, len(x) - 2)
    t = (xs - x[i]) / h[i]
    return ((2 * t**3 - 3 * t**2 + 1) * y[i] + (t**3 - 2 * t**2 + t) * h[i] * m[i]
            + (-2 * t**3 + 3 * t**2) * y[i + 1] + (t**3 - t**2) * h[i] * m[i + 1])


def decisions(games):
    q = np.array([x for g in games for x in g['q']])
    y = np.array([g['won'] for g in games for _ in g['q']], float)
    return q, y


def samples(games):
    """(fixed Q, grading Q, AI Q, won) at each game's sampled position."""
    return np.array([(g['q'][g['sample'][0]], *g['sample'][1:], g['won']) for g in games if g['sample']])


def monotone_fit(x, y, min_block, lo=None):
    """Nondecreasing E[y | x] on GRID, through (1, 1) and (0, lo); lo=None extends
    the first block's mean to x = 0."""
    order = np.argsort(x, kind='stable'); x, y = x[order], y[order]
    _, n = pav(y)
    # Merge PAV blocks until each has min_block points, so a handful of positions
    # can't put a kink in the curve; knots sit at each block's mean x.
    xs, ys, start = [], [], 0
    for end in np.cumsum(n):
        if end - start >= min_block or end == len(x):
            xs.append(x[start:end].mean()); ys.append(y[start:end].mean()); start = end
    xs, ys = np.array(xs), np.maximum.accumulate(ys)
    keep = np.r_[np.diff(xs) > 1e-9, True]          # blocks of identical x (Q = 1) share a knot
    xs, ys = xs[keep], ys[keep]
    if xs[0] > 0:
        xs, ys = np.r_[0, xs], np.r_[ys[0] if lo is None else lo, ys]
    if xs[-1] < 1:
        xs, ys = np.r_[xs, 1], np.r_[ys, 1]
    return np.clip(pchip(xs, ys, GRID), 0, 1)


def fit(games):
    """The AI's table and the review's: each maps its Q to the fixed-budget Q
    expected at that position, then to win%."""
    base = monotone_fit(*decisions(games), 150)
    fq, gq, aq, _ = samples(games).T
    return [np.interp(monotone_fit(q, fq, 60, lo=0), GRID, base) for q in (aq, gq)]


def current_tables():
    text = TABLE_TS.read_text()
    return [np.array([float(x) for x in re.search(rf'{name} = table\(\[([^\]]*)\]', text).group(1).split(',')
                      if x.strip()]) for name in ('winProb', 'gradedWinProb')]


def ts(table):
    nums = [f'{x:.4f}'.rstrip('0').rstrip('.') for x in table]
    return '[\n' + ''.join(f'  {", ".join(nums[i:i + 10])},\n' for i in range(0, len(nums), 10)) + ']'


def report(path, boot):
    games = [json.loads(line) for line in open(path)]
    q, _ = decisions(games)
    print(f'{len(games)} games, {len(q)} decisions; AI won {np.mean([g["won"] for g in games]):.4f}, '
          f'{sum(g["turns"] > 300 for g in games)} stalled at the turn limit')
    (play, graded), (cur, cur_graded) = fit(games), current_tables()
    rng = np.random.default_rng(1)
    reps = [fit([games[i] for i in rng.integers(0, len(games), len(games))]) for _ in range(boot)]
    print(f'\n{"Q":>6}  {"AI: current":>13} {"new":>6} {"90% by-game bootstrap":>22}  '
          f'{"review: current":>15} {"new":>6} {"90% bootstrap":>15}')
    for x in [0, .005, .01, .02, .03, .05, .07, .1, .15, .2, .3, .4, .5, .6, .7, .8, .9]:
        at = lambda t: np.interp(x, GRID, t)
        ci = [np.percentile([at(r[k]) for r in reps], [5, 95]) for k in (0, 1)]
        print(f'{x:6.3f}  {at(cur):13.3f} {at(play):6.3f} {f"[{ci[0][0]:.3f}, {ci[0][1]:.3f}]":>22}  '
              f'{at(cur_graded):15.3f} {at(graded):6.3f} {f"[{ci[1][0]:.3f}, {ci[1][1]:.3f}]":>15}')
    S = samples(games)
    print(f'\nAt {len(S)} sampled positions, the AI\'s and the review\'s Q against fixed-budget Q:')
    for lo, hi in [(0, .05), (.05, .2), (.2, .5), (.5, .8), (.8, .95)]:
        m = (S[:, 0] >= lo) & (S[:, 0] < hi)
        if m.any():
            print(f'  fixed Q {lo:.2f}-{hi:.2f}: n {m.sum():4d}, AI Q {S[m, 2].mean() - S[m, 0].mean():+.3f}, '
                  f'grading Q {S[m, 1].mean() - S[m, 0].mean():+.3f}; won {S[m, 3].mean():.3f}, '
                  f'AI table {np.interp(S[m, 2], GRID, play).mean():.3f}, review table {np.interp(S[m, 1], GRID, graded).mean():.3f}')
    print(f'\nexport const winProb = table({ts(play)});\nexport const gradedWinProb = table({ts(graded)});')


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('play')
    p.add_argument('--games', type=int, default=8000)
    p.add_argument('--seed-base', type=int, default=910000)
    p.add_argument('--workers', type=int, default=8)
    p.add_argument('--out', required=True)
    f = sub.add_parser('fit')
    f.add_argument('path')
    f.add_argument('--boot', type=int, default=100)
    args = ap.parse_args()
    if args.cmd == 'fit':
        return report(args.path, args.boot)
    t0 = time.time()
    seeds = range(args.seed_base, args.seed_base + args.games)
    with Pool(args.workers) as pool, open(args.out, 'a') as out:
        for i, g in enumerate(pool.imap_unordered(play, seeds, chunksize=2)):
            out.write(json.dumps(g) + '\n')
            out.flush()
            if i % 100 == 0:
                print(i, round(time.time() - t0), flush=True)


if __name__ == '__main__':
    main()
