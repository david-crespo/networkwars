"""Time several native engine builds on search_bench.py's positions, without
the parity assertion (builds with different FP contraction or -ffast-math
pick different moves, so only the work per search is comparable).

  uv run --project solver python engine/time_native.py a.so b.dylib ... [--seeds 12]

Each position runs every build in a rotating order; reports total seconds,
simulations, and µs per simulation (sims can differ where adaptive stops
diverge, so µs/sim is the fair number).
"""
import argparse
import importlib.util
import os
from pathlib import Path
import time

import numpy as np

SOLVER = Path(__file__).resolve().parents[1] / 'solver'


def load(path, name):
    os.environ['NW_ENGINE_SO'] = str(Path(path).resolve())
    spec = importlib.util.spec_from_file_location(name, SOLVER / 'fastnw.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('builds', nargs='+')
    ap.add_argument('--seeds', type=int, default=12)
    ap.add_argument('--sims', type=int, default=4000)
    ap.add_argument('--repeats', type=int, default=3)
    args = ap.parse_args()
    engines = [load(p, f'e{i}') for i, p in enumerate(args.builds)]
    k = len(engines)
    elapsed, sims = [0.0] * k, [0] * k
    rotation = 0
    for seed in range(1, args.seeds + 1):
        base = engines[0]
        g = base.new_game(seed)
        for turn in range(1, 5):
            if base.check_winner(g['owner']) >= 0 or not np.any(g['owner'] == 0):
                break
            for grade in (0, 1):
                for repeat in range(args.repeats):
                    rotation += 1
                    for j in range(k):
                        i = (j + rotation) % k
                        e = engines[i]
                        e.set_topology_csr(g['n'], g['adj'])
                        e.use_mb32(g['mb'])
                        e.use_sim(0x12345678)
                        e.set_grade(grade)
                        start = time.perf_counter()
                        e.uct_search(g['owner'], g['strength'], turn, args.sims, return_q=True,
                                     max_sims=args.sims * (2 if repeat == 1 else 1))
                        elapsed[i] += time.perf_counter() - start
                        sims[i] += e.sims_done()
            base.use_mb32(g['mb'])
            base.end_turn(g['owner'], g['strength'])
            g['mb'] = base.get_mb32()
    for path, t, s in zip(args.builds, elapsed, sims):
        print(f'{t:8.3f}s {s:9d} sims {1e6 * t / s:7.2f} µs/sim  {path}')


if __name__ == '__main__':
    main()
