//! RED's rollout policy (ranked, C1-tuned weights) and the sweep-up mop-up
//! policy with its Monte-Carlo certificate.

use crate::{
    Action, Board, CapTables, MAX_TURNS, MAXN, NF, RED, Rng, Topology, WIN_NODES, bits, check_winner,
    end_turn, reinforce, resolve_battle, run_bot_turn,
};

/// The C1 weight vector, baked in.
struct RankWeights {
    capture: f64,
    weak_target: f64,
    margin: f64,
    source: f64,
    red_adj: f64,
    merge: f64,
    largest_touch: f64,
    enemy_count: f64,
    eliminate: f64,
    exposure: f64,
    low_chance_penalty: f64,
    strong_target_penalty: f64,
    /// END competes at this score.
    threshold: f64,
}

const RW: RankWeights = RankWeights {
    capture: 44.687,
    weak_target: 69.885,
    margin: 9.789,
    source: 1.754,
    red_adj: 59.153,
    merge: 114.472,
    largest_touch: 77.164,
    enemy_count: 9.322,
    eliminate: 0.0,
    exposure: 60.487,
    low_chance_penalty: 140.411,
    strong_target_penalty: 0.0,
    threshold: 220.775,
};

/// RED's connected components: `label[i]` for red nodes, each label's node
/// set, and the largest (ties go to the one with the lowest node id).
struct RedComponents {
    label: [u8; MAXN],
    members: [u64; MAXN],
    n_labels: usize,
    largest: u8,
}

impl RedComponents {
    fn new(topo: &Topology, board: &Board) -> RedComponents {
        let mut comps = RedComponents {
            label: [u8::MAX; MAXN],
            members: [0; MAXN],
            n_labels: 0,
            largest: u8::MAX,
        };
        let mut rest = board.owned(RED);
        while rest != 0 {
            let component = topo.flood(rest.trailing_zeros() as usize, rest);
            rest &= !component;
            comps.set(comps.n_labels as u8, component);
            comps.n_labels += 1;
        }
        comps.find_largest();
        comps
    }

    fn set(&mut self, l: u8, component: u64) {
        self.members[l as usize] = component;
        for i in bits(component) {
            self.label[i] = l;
        }
    }

    fn find_largest(&mut self) {
        let mut best = (0, u32::MAX);
        for l in 0..self.n_labels {
            let m = self.members[l];
            let key = (m.count_ones(), m.trailing_zeros());
            if m != 0 && (key.0 > best.0 || key.0 == best.0 && key.1 < best.1) {
                best = key;
                self.largest = l as u8;
            }
        }
    }

    /// RED just captured `to`: it joins every component next to it. Exact only
    /// on a symmetric topology, where components are the connected ones.
    fn absorb(&mut self, topo: &Topology, board: &Board, to: usize) {
        let mut merged = 1u64 << to;
        let mut keep = self.n_labels as u8;
        for i in bits(topo.neighbor_mask(to) & board.owned(RED) & !(1 << to)) {
            let l = self.label[i];
            merged |= std::mem::take(&mut self.members[l as usize]);
            keep = keep.min(l);
        }
        if keep as usize == self.n_labels {
            self.n_labels += 1;
        }
        self.set(keep, merged);
        self.find_largest();
    }
}

/// Score one RED attack `from -> to` under the ranked weights.
#[allow(clippy::too_many_arguments)]
#[inline]
fn ranked_score(
    topo: &Topology,
    tables: &mut CapTables,
    board: &Board,
    c: &[i32; NF],
    comps: &RedComponents,
    from: usize,
    to: usize,
    source: f64,
) -> f64 {
    let (fs, ts) = (board.strength[from], board.strength[to]);
    let p_cap = tables.capture_prob(fs, ts);
    let e_str = tables.expected_occupier(fs, ts);
    let e_str_i = ((e_str + 0.5) as i32).max(1);

    let mut touched = 0u64;
    let (mut merge_count, mut red_adj, mut touches_largest) = (0i32, 0i32, false);
    let mut exposure = 0.0;
    let mut touch = |label: u8| {
        if label != u8::MAX && touched & (1 << label) == 0 {
            touched |= 1 << label;
            merge_count += 1;
            if label == comps.largest {
                touches_largest = true;
            }
        }
    };
    for nb in topo.neighbors(to) {
        if board.owner[nb] == RED {
            red_adj += 1;
            touch(comps.label[nb]);
        } else if nb != from && board.strength[nb] as f64 > e_str {
            exposure += tables.capture_prob(board.strength[nb], e_str_i);
        }
    }
    touch(comps.label[from]);
    let merge_count = (merge_count - 1).max(0);

    let margin = (fs - ts) as f64;
    let weak_target = 1.0 / ts.max(1) as f64;
    let strong_penalty = (ts - 3).max(0) as f64;
    let enemies = c[board.owner[to] as usize];

    let mut score = 0.0;
    score += p_cap * RW.capture;
    score += weak_target * RW.weak_target;
    score += margin * RW.margin;
    score += source * RW.source;
    score += red_adj as f64 * RW.red_adj;
    score += merge_count as f64 * RW.merge;
    if touches_largest {
        score += RW.largest_touch;
    }
    score += enemies as f64 * RW.enemy_count;
    if enemies == 1 {
        score += RW.eliminate;
    }
    score -= exposure * RW.exposure;
    score -= (0.45 - p_cap).max(0.0) * RW.low_chance_penalty;
    score -= strong_penalty * RW.strong_target_penalty;
    if c[RED as usize] >= WIN_NODES - 1 {
        score += 100000.0;
    }
    score
}

pub fn ranked_best_move(topo: &Topology, tables: &mut CapTables, board: &Board) -> Action {
    best_move_with(topo, tables, board, &RedComponents::new(topo, board))
}

fn best_move_with(topo: &Topology, tables: &mut CapTables, board: &Board, comps: &RedComponents) -> Action {
    let c = topo.counts(board);
    let mut best_action = Action::END;
    let mut best = RW.threshold;
    for from in bits(board.owned(RED)) {
        let fs = board.strength[from];
        if fs <= 1 || !topo.on_border(board, from, RED) {
            continue;
        }
        let source = match tables.source_log.get(fs as usize) {
            Some(&s) => s,
            None => (fs as f64).log2(),
        };
        for to in topo.neighbors(from) {
            if board.owner[to] == RED {
                continue;
            }
            let s = ranked_score(topo, tables, board, &c, comps, from, to, source);
            if s > best {
                best = s;
                best_action = Action::attack(from, to);
            }
        }
    }
    best_action
}

/// Play to the end with RED on the ranked policy. True iff RED wins; a
/// plurality at the turn horizon is not a win.
pub fn rollout(
    topo: &Topology,
    tables: &mut CapTables,
    rng: &mut impl Rng,
    start: &Board,
    mut turns: i32,
) -> bool {
    let mut board = *start;
    let red_won = |board: &Board| check_winner(topo, board).map(|w| w == RED);
    loop {
        if let Some(won) = red_won(&board) {
            return won;
        }
        if board.owned(RED) == 0 {
            return false;
        }
        // A repel changes no owner, so the components only change on a capture.
        let mut comps = RedComponents::new(topo, &board);
        for _ in 0..200 {
            let Some((from, to)) = best_move_with(topo, tables, &board, &comps).target() else {
                break;
            };
            resolve_battle(rng, &mut board, from, to);
            // Only a capture can change the winner.
            if board.owner[to] == RED {
                if check_winner(topo, &board).is_some() {
                    break;
                }
                if topo.symmetric() {
                    comps.absorb(topo, &board, to);
                } else {
                    comps = RedComponents::new(topo, &board);
                }
            }
        }
        if let Some(won) = red_won(&board) {
            return won;
        }
        reinforce(topo, &mut board, RED);
        if let Some(won) = red_won(&board) {
            return won;
        }
        for bot in 1..NF as u8 {
            run_bot_turn(topo, rng, &mut board, bot);
            if check_winner(topo, &board).is_some() {
                break;
            }
        }
        if let Some(won) = red_won(&board) {
            return won;
        }
        turns += 1;
        if turns > MAX_TURNS {
            return false;
        }
    }
}

/// The sweep-up rule: the strongest RED stack hits a strictly weaker adjacent
/// enemy, bigger margin breaking ties; END if there is none.
pub fn sweep_best_move(topo: &Topology, board: &Board) -> Action {
    let mut best: Option<(Action, i32, i32)> = None;
    for i in bits(board.owned(RED)) {
        let a = board.strength[i];
        if a < 2 {
            continue;
        }
        for j in topo.neighbors(i) {
            if board.owner[j] == RED {
                continue;
            }
            let m = a - board.strength[j];
            if m <= 0 {
                continue;
            }
            if best.is_none_or(|(_, bs, bm)| a > bs || (a == bs && m > bm)) {
                best = Some((Action::attack(i, j), a, m));
            }
        }
    }
    best.map_or(Action::END, |(action, _, _)| action)
}

/// One sweep playout to the end. True iff RED wins. A stall at the horizon
/// is a loss: the mop-up never takes an even fight, so lockstep borders never
/// end, and such a sweep must not be certified.
fn sweep_playout(topo: &Topology, rng: &mut impl Rng, start: &Board, mut turns: i32) -> bool {
    let mut board = *start;
    loop {
        if let Some(w) = check_winner(topo, &board) {
            return w == RED;
        }
        // A wiped RED can never move again.
        if topo.counts(&board)[RED as usize] == 0 {
            return false;
        }
        if let Some((from, to)) = sweep_best_move(topo, &board).target() {
            resolve_battle(rng, &mut board, from, to);
            continue;
        }
        end_turn(topo, rng, &mut board);
        turns += 1;
        if turns > MAX_TURNS {
            return check_winner(topo, &board) == Some(RED);
        }
    }
}

/// Run up to `trials` sweep playouts and return the number lost, stopping
/// once that exceeds `max_losses` (so the pass test is `<= max_losses`).
pub fn sweep_certify(
    topo: &Topology,
    rng: &mut impl Rng,
    board: &Board,
    turns: i32,
    trials: i32,
    max_losses: i32,
) -> i32 {
    let mut losses = 0;
    let mut i = 0;
    while i < trials && losses <= max_losses {
        if !sweep_playout(topo, rng, board, turns) {
            losses += 1;
        }
        i += 1;
    }
    losses
}
