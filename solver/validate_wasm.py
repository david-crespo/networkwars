"""WASM parity + regression gate.

Proves the in-browser engine (src/nw_engine.wasm, the Rust port in engine/) is faithful
to the native build of the same engine:
  1. board-gen BIT-PARITY: new_game(seed) owner/strength fingerprints match native
     for every seed (board-gen is pure integer math + an exact pow-of-2 divide, so it
     reproduces bit-for-bit across native-arm64 and wasm32).
  2. WASM structural + battle invariants + determinism (run by solver/wasm_gate.mjs,
     mirroring validate_fast.py).

(The search is covered by the golden traces in `cargo nextest run` in engine/, and
its strength by the offline winrate evals.)

Run: uv run python solver/validate_wasm.py [nseeds]
"""
import hashlib
import subprocess
import sys
import os

import fastnw

HERE = os.path.dirname(os.path.abspath(__file__))


def native_fp(seed):
    g = fastnw.new_game(seed)
    return hashlib.md5(g['owner'].tobytes() + g['strength'].tobytes()).hexdigest()[:12]


def main():
    nseeds = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    print(f'running WASM gate over {nseeds} seeds (node)...')
    proc = subprocess.run(['node', os.path.join(HERE, 'wasm_gate.mjs'), str(nseeds)],
                          capture_output=True, text=True)
    # node prints invariant/battle summaries to stderr, `FP <seed> <hex>` to stdout
    sys.stderr.write(proc.stderr)
    wasm_fp = {}
    for line in proc.stdout.splitlines():
        if line.startswith('FP '):
            _, seed, h = line.split()
            wasm_fp[int(seed)] = h

    mism = 0
    for seed in range(1, nseeds + 1):
        nfp = native_fp(seed)
        wfp = wasm_fp.get(seed)
        if wfp != nfp:
            mism += 1
            if mism <= 5:
                print(f'  seed {seed}: board mismatch native={nfp} wasm={wfp}')
    print(f'board-gen parity: {nseeds - mism}/{nseeds} seeds bit-identical')

    ok = (proc.returncode == 0) and (mism == 0)
    print('RESULT:', 'ALL CHECKS PASS' if ok else 'FAILURES')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
