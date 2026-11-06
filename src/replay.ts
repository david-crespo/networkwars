// Keep the two inspected trajectories (you + AI) in memory. Concurrent hovers
// share the same request; revisiting any move needs no replay or worker message.
import { RULES_VERSION } from './game-version.ts';
import type { Api, GameView, Move, Reply } from './types.ts';

interface Entry { seed: number; rules: number; moves: Move[]; length: number; result?: Promise<GameView[]> }

export function createReplayInspector(api: Api) {
  const cache: Entry[] = [];
  return async (seed: number, moves: Move[], k: number, rules = RULES_VERSION) => {
    if (!Number.isInteger(k) || k < 0 || k >= moves.length) throw new Error('invalid move index');
    let entry: Entry | undefined = cache.find(e => e.seed === seed && e.rules === rules && e.moves === moves && e.length === moves.length);
    if (!entry) {
      const e: Entry = entry = { seed, rules, moves, length: moves.length };
      e.result = api<Reply & { frames: GameView[] }>('/api/replay', 'POST', { seed, rules, moves }).then(r => {
        if (r.error) throw new Error(r.error);
        return r.frames;
      }).catch(err => {
        const i = cache.indexOf(e);
        if (i >= 0) cache.splice(i, 1);
        throw err;
      });
      cache.push(e);
      if (cache.length > 2) cache.shift();
    }
    return (await entry.result!)[k];
  };
}
