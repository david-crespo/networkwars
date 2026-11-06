//! Open-loop PUCT/MCTS for RED: uniform priors, rollout leaf values, bots
//! folded into END, dice (the private stream, fresh each simulation) the only
//! randomness.
//!
//! Chance-split tree: an attack edge has one child per sampled outcome
//! (capture, repel) so the subtree below is outcome-coherent; edge stats stay
//! action-level, so selection ranks actions by their outcome-averaged value.
//! END keeps one child. Open-loop nodes see many boards, so each node keeps
//! the union of observed legal actions and selects only among those legal on
//! the current simulation's board.

use crate::{
    Action, Board, CapTables, MAX_TURNS, MAXN, RED, Rng, Topology, bits, end_turn, resolve_battle,
    rollout, winner_from_counts,
};

/// Directed edges plus END.
pub const MAXCHILD: usize = MAXN * 8 + 1;
/// Adaptive stop: re-check the root this often.
const CHECK_EVERY: i32 = 256;
const MAX_PATH: usize = 16384;
/// Grading mode: each root child gets at least this fraction of a uniform share.
const GRADE_FLOOR_FRAC: f64 = 0.35;
/// Below this many post-snapshot visits, report the cumulative Q.
const GRADE_MIN_HALF: i32 = 16;

#[derive(Clone, Copy, Default)]
struct Node {
    n_children: u16,
    child_cap: u16,
    child_off: u32,
    expanded: bool,
    terminal: bool,
    /// Sum of child visits (times selected through).
    total_n: i64,
    v: f64,
}

const NO_CHILD: i32 = -1;

#[derive(Clone, Copy)]
struct Edge {
    action: Action,
    /// The child after END or a capture.
    child: i32,
    /// The child after a repel.
    child_repel: i32,
    n: i32,
    w: f64,
}

impl Edge {
    const EMPTY: Edge = Edge {
        action: Action::END,
        child: NO_CHILD,
        child_repel: NO_CHILD,
        n: 0,
        w: 0.0,
    };

    #[inline]
    fn q(&self, fallback: f64) -> f64 {
        if self.n > 0 {
            self.w / self.n as f64
        } else {
            fallback
        }
    }
}

/// Optional value-based early stop, off by default: once the leader has
/// `min_vis` visits and its value is decisive (`<= lo` or `>= hi`) or beats
/// the runner-up by `gap`, stop.
#[derive(Clone, Copy, Debug)]
pub struct ValueStop {
    pub lo: f64,
    pub hi: f64,
    pub gap: f64,
    pub min_vis: i32,
}

impl Default for ValueStop {
    fn default() -> Self {
        ValueStop {
            lo: -1.0,
            hi: 2.0,
            gap: 2.0,
            min_vis: 1 << 30,
        }
    }
}

/// Optional relative-margin stop, off by default: stop once the leader has
/// `ratio` times the runner-up's visits, or RED is not behind (`>= behind`).
#[derive(Clone, Copy, Debug)]
pub struct DeepThink {
    pub ratio: f64,
    pub min_vis: i32,
    pub behind: f64,
}

impl Default for DeepThink {
    fn default() -> Self {
        DeepThink {
            ratio: 0.0,
            min_vis: 1 << 30,
            behind: 2.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RootChild {
    pub action: Action,
    pub visits: i32,
    pub q: f64,
}

#[derive(Debug)]
pub struct SetupError;

/// The search tree, its pools, and the knobs that persist across searches.
#[derive(Default)]
pub struct Search {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    node_cap: usize,
    edge_cap: usize,
    path: Vec<u32>,

    root_turns: i32,
    cpuct: f64,
    nroll: i32,
    min_sims: i32,
    max_sims: i32,
    finished: bool,
    sims: i32,
    root_board: Board,

    /// Grading mode (0 off, 1 floor + no stops + second-half Q, 2 floor + no
    /// stops + cumulative Q). For comparing root moves, not picking one fast.
    pub grade: i32,
    snapshot: Option<Vec<(i32, f64)>>,
    pub value_stop: ValueStop,
    pub deep_think: DeepThink,
}

/// RED's legal actions on `board` (attacks in node/adjacency order, then END).
fn legal_red(topo: &Topology, board: &Board, out: &mut [Action; MAXCHILD]) -> usize {
    let mut n = 0;
    for i in bits(board.owned(RED)) {
        if board.strength[i] <= 1 {
            continue;
        }
        for j in topo.neighbors(i) {
            if board.owner[j] != RED {
                out[n] = Action::attack(i, j);
                n += 1;
            }
        }
    }
    out[n] = Action::END;
    n + 1
}

/// Apply one RED action. `Some(red_won)` if the game ended; the horizon is a loss.
fn apply_red(
    topo: &Topology,
    rng: &mut impl Rng,
    board: &mut Board,
    action: Action,
    turns: &mut i32,
) -> Option<bool> {
    match action.target() {
        None => {
            end_turn(topo, rng, board);
            *turns += 1;
        }
        Some((from, to)) => resolve_battle(rng, board, from, to),
    }
    let c = topo.counts(board);
    let w = winner_from_counts(&c);
    if w.is_some() || c[RED as usize] == 0 {
        return Some(w == Some(RED));
    }
    if action == Action::END && *turns > MAX_TURNS {
        return Some(false);
    }
    None
}

impl Search {
    fn new_node(&mut self) -> Option<u32> {
        if self.nodes.len() >= self.node_cap {
            return None;
        }
        self.nodes.push(Node {
            v: 0.5,
            ..Node::default()
        });
        Some(self.nodes.len() as u32 - 1)
    }

    /// Merge `legal` into the node's action union; `available[k]` is the
    /// child index of `legal[k]`. False if the edge pool is exhausted.
    fn sync_actions(&mut self, id: usize, legal: &[Action], available: &mut [usize; MAXCHILD]) -> bool {
        let node = self.nodes[id];
        let (off, nch) = (node.child_off as usize, node.n_children as usize);
        let mut missing = [Action::END; MAXCHILD];
        let mut nm = 0;
        for (k, &action) in legal.iter().enumerate() {
            let mut j = k;
            if j >= nch || self.edges[off + j].action != action {
                j = (0..nch)
                    .find(|&j| self.edges[off + j].action == action)
                    .unwrap_or(nch);
            }
            if j == nch {
                missing[nm] = action;
                j += nm;
                nm += 1;
            }
            available[k] = j;
        }
        let need = nch + nm;
        let node = &mut self.nodes[id];
        if need > node.child_cap as usize {
            let cap = if node.child_cap > 0 {
                node.child_cap as usize * 2
            } else {
                need
            };
            let cap = cap.max(need).min(MAXCHILD);
            let new_off = self.edges.len();
            if new_off + cap > self.edge_cap {
                return false;
            }
            // Relocating is safe: children store node ids, and no ancestor is
            // grown after its edge joined this simulation's path.
            self.edges.extend_from_within(off..off + nch);
            self.edges.resize(new_off + cap, Edge::EMPTY);
            node.child_off = new_off as u32;
            node.child_cap = cap as u16;
        }
        let off = node.child_off as usize + nch;
        node.n_children += nm as u16;
        for (e, &action) in self.edges[off..off + nm].iter_mut().zip(&missing[..nm]) {
            *e = Edge {
                action,
                ..Edge::EMPTY
            };
        }
        true
    }

    /// Reset the tree for a search from `board`.
    #[allow(clippy::too_many_arguments)]
    pub fn begin(
        &mut self,
        topo: &Topology,
        board: &Board,
        root_turns: i32,
        min_sims: i32,
        max_sims: i32,
        cpuct: f64,
        nroll: i32,
    ) -> Result<(), SetupError> {
        let min_sims = min_sims.max(1);
        let max_sims = max_sims.max(min_sims);
        // Measured peak: ~1.0 nodes/sim, ~7-8 edges/node. Overflow degrades
        // gracefully (a full pool falls back to a leaf).
        let node_cap = max_sims as usize + max_sims as usize / 2 + 4096;
        let edge_cap = node_cap * 12;
        self.nodes.clear();
        self.edges.clear();
        self.path.clear();
        self.nodes.try_reserve_exact(node_cap).map_err(|_| SetupError)?;
        self.edges.try_reserve_exact(edge_cap).map_err(|_| SetupError)?;
        self.path.try_reserve_exact(MAX_PATH).map_err(|_| SetupError)?;
        self.node_cap = node_cap;
        self.edge_cap = edge_cap;
        self.new_node();
        self.root_turns = root_turns;
        self.cpuct = cpuct;
        self.nroll = nroll.max(1);
        self.min_sims = min_sims;
        self.max_sims = max_sims;
        self.sims = 0;
        self.finished = false;
        self.snapshot = None;
        self.root_board = *board;
        let c = topo.counts(board);
        let w = winner_from_counts(&c);
        if w.is_some() || c[RED as usize] == 0 {
            let root = &mut self.nodes[0];
            root.expanded = true;
            root.terminal = true;
            root.v = if w == Some(RED) { 1.0 } else { 0.0 };
        }
        Ok(())
    }

    /// One simulation against the persistent tree.
    fn simulate(&mut self, topo: &Topology, tables: &mut CapTables, rng: &mut impl Rng) {
        let mut legal = [Action::END; MAXCHILD];
        let mut available = [0usize; MAXCHILD];
        let mut board = self.root_board;
        let mut turns = self.root_turns;
        let mut cur = 0usize;
        self.path.clear();

        let leaf_value = loop {
            if self.path.len() >= MAX_PATH {
                break self.nodes[cur].v;
            }
            let node = self.nodes[cur];
            // Only an already-terminal root is cached; chance outcomes never are.
            if node.terminal {
                break node.v;
            }
            let nc = legal_red(topo, &board, &mut legal);
            if !self.sync_actions(cur, &legal[..nc], &mut available) {
                break rollout(topo, tables, rng, &board, turns) as i32 as f64;
            }
            if !node.expanded {
                let mut v = 0.0;
                for _ in 0..self.nroll {
                    v += rollout(topo, tables, rng, &board, turns) as i32 as f64;
                }
                v /= self.nroll as f64;
                let node = &mut self.nodes[cur];
                node.expanded = true;
                node.v = v;
                break v;
            }
            let node = self.nodes[cur];
            let off = node.child_off as usize;
            let edges = &self.edges[off..off + node.n_children as usize];
            let mut best_k = None;
            // Grading mode: top up the most-starved root child whenever it
            // falls under its share, so every move's Q stays comparable.
            if self.grade != 0 && cur == 0 && nc > 1 {
                let need = (GRADE_FLOOR_FRAC * node.total_n as f64 / nc as f64) as i64;
                let (mut mk, mut mn) = (0, edges[0].n);
                for (k, e) in edges.iter().enumerate().take(nc).skip(1) {
                    if e.n < mn {
                        mn = e.n;
                        mk = k;
                    }
                }
                if (mn as i64) < need {
                    best_k = Some(mk);
                }
            }
            let best_k = best_k.unwrap_or_else(|| {
                let sqrt_total = (node.total_n as f64).sqrt() + 1e-8;
                let explore = self.cpuct / nc as f64 * sqrt_total;
                let mut best_u = -1e30;
                let mut best = available[0];
                for &k in &available[..nc] {
                    let e = &edges[k];
                    let u = e.q(node.v) + explore / (1 + e.n) as f64;
                    if u > best_u {
                        best_u = u;
                        best = k;
                    }
                }
                best
            });
            let eidx = off + best_k;
            self.nodes[cur].total_n += 1;
            self.path.push(eidx as u32);
            let action = self.edges[eidx].action;
            if let Some(red_won) = apply_red(topo, rng, &mut board, action, &mut turns) {
                // A sampled terminal is not a proof about an open-loop child.
                break if red_won { 1.0 } else { 0.0 };
            }
            if turns > MAX_TURNS {
                break 0.0;
            }
            let repelled = matches!(action.target(), Some((_, to)) if board.owner[to] != RED);
            let edge = &self.edges[eidx];
            let child = if repelled { edge.child_repel } else { edge.child };
            cur = if child >= 0 {
                child as usize
            } else {
                let Some(id) = self.new_node() else {
                    break self.nodes[cur].v;
                };
                let edge = &mut self.edges[eidx];
                *(if repelled {
                    &mut edge.child_repel
                } else {
                    &mut edge.child
                }) = id as i32;
                id as usize
            };
        };

        for &eidx in &self.path {
            let e = &mut self.edges[eidx as usize];
            e.n += 1;
            e.w += leaf_value;
        }
        self.sims += 1;
    }

    /// The root's children, in union order.
    fn root_edges(&self) -> &[Edge] {
        match self.nodes.first() {
            Some(root) => {
                let off = root.child_off as usize;
                &self.edges[off..off + root.n_children as usize]
            }
            None => &[],
        }
    }

    /// Stop when the runner-up cannot catch the leader in the sims left
    /// (move-identical to running on), or when an enabled optional stop fires.
    fn should_stop(&self) -> bool {
        if !self.nodes[0].expanded {
            return false;
        }
        let edges = self.root_edges();
        let (mut b1, mut b2, mut b1k, mut b2k) = (-1i64, -1i64, None, None);
        for (k, e) in edges.iter().enumerate() {
            let n = e.n as i64;
            if n > b1 {
                (b2, b2k) = (b1, b1k);
                (b1, b1k) = (n, Some(k));
            } else if n > b2 {
                (b2, b2k) = (n, Some(k));
            }
        }
        // A winning leader says nothing about the cost of the alternatives:
        // grade every one through the full budget unless the move is forced.
        if self.grade != 0 {
            return edges.len() <= 1;
        }
        let remaining = (self.max_sims - self.sims) as i64;
        if edges.len() <= 1 || b1 - b2 > remaining {
            return true;
        }
        let q = |k: Option<usize>, n: i64| edges[k.unwrap()].w / n as f64;
        let dt = &self.deep_think;
        if dt.ratio > 0.0 && b1 >= dt.min_vis as i64 {
            if b1 as f64 >= dt.ratio * (b2 + 1) as f64 {
                return true;
            }
            if q(b1k, b1) >= dt.behind {
                return true;
            }
        }
        let vs = &self.value_stop;
        if b1 >= vs.min_vis as i64 && b1k.is_some() {
            let q1 = q(b1k, b1);
            if q1 <= vs.lo || q1 >= vs.hi {
                return true;
            }
            if b2k.is_some() && b2 >= vs.min_vis as i64 && q1 - q(b2k, b2) >= vs.gap {
                return true;
            }
        }
        false
    }

    /// Run up to `budget` more simulations; true once finished (early stop
    /// or `max_sims`). The stop is checked on the same cadence however the
    /// search is chunked, so chunked and one-shot runs are identical.
    pub fn step(&mut self, topo: &Topology, tables: &mut CapTables, rng: &mut impl Rng, budget: i32) -> bool {
        if self.finished {
            return true;
        }
        let target = (self.sims as i64 + budget as i64).min(self.max_sims as i64) as i32;
        while self.sims < target {
            self.simulate(topo, tables, rng);
            // Grading mode 1 reports Qs from the second half only. Selection
            // never reads the snapshot, so the tree is the same either way.
            if self.grade == 1
                && self.snapshot.is_none()
                && self.sims >= (self.max_sims + 1) / 2
                && self.nodes[0].expanded
            {
                self.snapshot = Some(self.root_edges().iter().map(|e| (e.n, e.w)).collect());
            }
            if self.sims >= self.min_sims
                && self.sims < self.max_sims
                && self.sims % CHECK_EVERY == 0
                && self.should_stop()
            {
                self.finished = true;
                return true;
            }
        }
        self.finished = self.sims >= self.max_sims;
        self.finished
    }

    /// Root children: action, visits, and backed-up RED win probability.
    pub fn report(&self) -> impl Iterator<Item = RootChild> + '_ {
        let root_v = self.nodes.first().map_or(0.5, |r| r.v);
        self.root_edges().iter().enumerate().map(move |(k, e)| {
            let mut q = e.q(root_v);
            if self.grade == 1
                && let Some(&(n0, w0)) = self.snapshot.as_ref().and_then(|s| s.get(k))
            {
                let dn = e.n - n0;
                if dn >= GRADE_MIN_HALF {
                    q = (e.w - w0) / dn as f64;
                }
            }
            RootChild {
                action: e.action,
                visits: e.n,
                q,
            }
        })
    }

    pub fn sims_done(&self) -> i32 {
        self.sims
    }
}
