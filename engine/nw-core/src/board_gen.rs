//! Board generation and the iOS deal, on the seeded mulberry32 stream.
//!
//! 6x7 king-adjacency lattice, then connectivity-preserving vertex removal
//! down to 30 nodes, then the deal: each faction totals 20 armies from one of
//! four fixed templates. Rules version 2 places the large stacks as recovered
//! connected singles/pairs/triples; version 1 keeps the former territorial
//! growth + shuffled deal so saved games replay with the same dice.

use crate::{Board, Faction, MAXN, Mulberry32, NF, Rng, Topology};

const GRID_ROWS: usize = 7;
const GRID_COLS: usize = 6;
const CELLS: usize = GRID_ROWS * GRID_COLS;
const TARGET_NODES: usize = 30;
const OWNER_SCATTER: f64 = 0.6;
const FREE: i32 = -1;

/// Per-faction strengths summing to 20, and their cumulative probabilities
/// (MLE over 2163 live faction-deals).
const DEAL_TEMPLATES: [[i32; 6]; 4] = [
    [1, 1, 1, 5, 6, 6],
    [1, 1, 1, 1, 8, 8],
    [1, 1, 4, 4, 5, 5],
    [1, 3, 4, 4, 4, 4],
];
const DEAL_CUM: [f64; 4] = [0.392, 0.722, 0.923, 1.0];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RulesVersion {
    /// Unversioned/v1 saved games only.
    Legacy,
    Current,
}

#[derive(Clone, Debug)]
pub struct GeneratedGame {
    pub topology: Topology,
    pub board: Board,
    pub x: [i32; MAXN],
    pub y: [i32; MAXN],
}

/// Fisher-Yates, matching Python's `shuffle()` on the same stream.
fn shuffle<T>(rng: &mut Mulberry32, a: &mut [T]) {
    for i in (1..a.len()).rev() {
        let j = (rng.next_f64() * (i + 1) as f64) as usize;
        a.swap(i, j);
    }
}

fn pick_template(rng: &mut Mulberry32) -> &'static [i32; 6] {
    let r = rng.next_f64();
    let t = DEAL_CUM.iter().position(|&c| r < c).unwrap_or(3);
    &DEAL_TEMPLATES[t]
}

/// The king-move lattice; neighbor order is the network_wars append order.
struct Grid {
    adj: [[usize; 8]; CELLS],
    deg: [usize; CELLS],
}

impl Grid {
    fn new() -> Grid {
        let mut g = Grid {
            adj: [[0; 8]; CELLS],
            deg: [0; CELLS],
        };
        let mut link = |u: usize, v: usize| {
            g.adj[u][g.deg[u]] = v;
            g.deg[u] += 1;
            g.adj[v][g.deg[v]] = u;
            g.deg[v] += 1;
        };
        for r in 0..GRID_ROWS {
            for c in 0..GRID_COLS {
                let a = r * GRID_COLS + c;
                if c + 1 < GRID_COLS {
                    link(a, r * GRID_COLS + c + 1);
                }
                if r + 1 < GRID_ROWS {
                    link(a, (r + 1) * GRID_COLS + c);
                    if c >= 1 {
                        link(a, (r + 1) * GRID_COLS + c - 1);
                    }
                    if c + 1 < GRID_COLS {
                        link(a, (r + 1) * GRID_COLS + c + 1);
                    }
                }
            }
        }
        g
    }

    fn neighbors(&self, g: usize) -> &[usize] {
        &self.adj[g][..self.deg[g]]
    }

    /// Are the live cells other than `excluded` still connected?
    fn connected_without(&self, alive: &[bool; CELLS], n_alive: usize, excluded: usize) -> bool {
        let Some(start) = (0..CELLS).find(|&g| alive[g] && g != excluded) else {
            return false;
        };
        let mut seen = [false; CELLS];
        let mut stack = vec![start];
        seen[start] = true;
        let mut count = 0;
        while let Some(g) = stack.pop() {
            count += 1;
            for &nb in self.neighbors(g) {
                if nb != excluded && alive[nb] && !seen[nb] {
                    seen[nb] = true;
                    stack.push(nb);
                }
            }
        }
        count == n_alive - 1
    }
}

/// Deal a fresh game. The stream should start at the seed; it is left just
/// past board generation, where the real game's dice continue.
pub fn generate(rng: &mut Mulberry32, rules: RulesVersion) -> GeneratedGame {
    let grid = Grid::new();
    loop {
        let (topology, x, y) = random_map(rng, &grid);
        let owner_strength = match rules {
            RulesVersion::Current => deal_clusters(rng, &topology),
            RulesVersion::Legacy => Some(deal_legacy(rng, &topology)),
        };
        // A group that cannot be placed draws a new map; never split it.
        if let Some((owner, strength)) = owner_strength {
            let mut board = Board::EMPTY;
            for i in topology.nodes() {
                board.owner[i] = owner[i] as Faction;
                board.strength[i] = strength[i];
            }
            return GeneratedGame {
                topology,
                board,
                x,
                y,
            };
        }
    }
}

fn random_map(rng: &mut Mulberry32, grid: &Grid) -> (Topology, [i32; MAXN], [i32; MAXN]) {
    let mut alive = [true; CELLS];
    let mut n_alive = CELLS;
    while n_alive > TARGET_NODES {
        let mut candidates: Vec<usize> = (0..CELLS).filter(|&g| alive[g]).collect();
        shuffle(rng, &mut candidates);
        let Some(&cell) = candidates
            .iter()
            .find(|&&g| grid.connected_without(&alive, n_alive, g))
        else {
            break;
        };
        alive[cell] = false;
        n_alive -= 1;
    }

    // Survivors reindexed ascending, keeping grid coordinates.
    let survivors: Vec<usize> = (0..CELLS).filter(|&g| alive[g]).collect();
    let mut new_id = [usize::MAX; CELLS];
    let (mut x, mut y) = ([0; MAXN], [0; MAXN]);
    for (i, &g) in survivors.iter().enumerate() {
        new_id[g] = i;
        x[i] = (g % GRID_COLS) as i32;
        y[i] = (g / GRID_COLS) as i32;
    }

    // Links in network_wars order: survivors ascending x lattice neighbor
    // order, deduplicated, each new link appended in both directions.
    let n = survivors.len();
    let mut lists: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut seen = [[false; MAXN]; MAXN];
    for (a, &g) in survivors.iter().enumerate() {
        for &nb in grid.neighbors(g) {
            if !alive[nb] {
                continue;
            }
            let b = new_id[nb];
            let (lo, hi) = (a.min(b), a.max(b));
            if !seen[lo][hi] {
                seen[lo][hi] = true;
                lists[lo].push(hi);
                lists[hi].push(lo);
            }
        }
    }
    (Topology::from_lists(&lists), x, y)
}

/// MapMaker.findBuildCluster/getBuildCluster: try free starts in shuffled
/// order and grow a connected single, pair, or triple (fork or path).
fn place_group(
    rng: &mut Mulberry32,
    topo: &Topology,
    owner: &mut [i32; MAXN],
    strength: &mut [i32; MAXN],
    faction: usize,
    armies: &[i32],
) -> bool {
    let free_neighbors = |owner: &[i32; MAXN], node: usize, except: Option<usize>| -> Vec<usize> {
        topo.neighbors(node)
            .filter(|&j| owner[j] == FREE && Some(j) != except)
            .collect()
    };
    let mut starts: Vec<usize> = topo.nodes().filter(|&i| owner[i] == FREE).collect();
    shuffle(rng, &mut starts);
    for &start in &starts {
        let mut group = vec![start];
        if armies.len() > 1 {
            let mut nbs = free_neighbors(owner, start, None);
            if nbs.is_empty() {
                continue;
            }
            shuffle(rng, &mut nbs);
            group.push(nbs[0]);
            if armies.len() == 3 {
                if nbs.len() >= 2 {
                    group.push(nbs[1]);
                } else {
                    let mut nbs = free_neighbors(owner, group[1], Some(start));
                    if nbs.is_empty() {
                        continue;
                    }
                    shuffle(rng, &mut nbs);
                    group.push(nbs[0]);
                }
            }
        }
        for (&node, &armies) in group.iter().zip(armies) {
            owner[node] = faction as i32;
            strength[node] = armies;
        }
        return true;
    }
    false
}

/// Recovered placement (MAP_DEAL_DECOMPILED.md): larger stacks first, in
/// faction order, as connected groups; shuffled one-army fillers take the
/// remaining cells (MapMaker.buildSingleArmies). `None` = redraw the map.
fn deal_clusters(rng: &mut Mulberry32, topo: &Topology) -> Option<([i32; MAXN], [i32; MAXN])> {
    let mut owner = [FREE; MAXN];
    let mut strength = [1; MAXN];
    let mut big: [Vec<i32>; NF] = Default::default();
    let mut singles = Vec::new();
    for (f, stacks) in big.iter_mut().enumerate() {
        // splitArmies puts the larger parts first.
        for &armies in pick_template(rng).iter().rev() {
            if armies > 1 {
                stacks.push(armies);
            } else {
                singles.push(f as i32);
            }
        }
    }
    for (f, stacks) in big.iter().enumerate() {
        let n = stacks.len();
        let split_pair = n == 2 && rng.next_f64() < 0.5;
        let mut place = |armies: &[i32]| place_group(rng, topo, &mut owner, &mut strength, f, armies);
        let mut pos = 0;
        if split_pair {
            // Two separate singles instead of a pair.
            if !place(&stacks[0..1]) || !place(&stacks[1..2]) {
                return None;
            }
            continue;
        }
        if n % 2 == 1 {
            if !place(&stacks[0..3]) {
                return None;
            }
            pos = 3;
        }
        while pos < n {
            if !place(&stacks[pos..pos + 2]) {
                return None;
            }
            pos += 2;
        }
    }
    shuffle(rng, &mut singles);
    let mut fillers = singles.into_iter();
    for i in topo.nodes() {
        if owner[i] == FREE {
            owner[i] = fillers.next()?;
        }
    }
    fillers.next().is_none().then_some((owner, strength))
}

/// Version 1: territorial growth from one seed per faction (scattered with
/// probability OWNER_SCATTER), then each faction's six nodes get a shuffled
/// template.
fn deal_legacy(rng: &mut Mulberry32, topo: &Topology) -> ([i32; MAXN], [i32; MAXN]) {
    let n = topo.n();
    let mut own = [FREE; MAXN];
    let mut count = [0; NF];
    let mut pool: Vec<usize> = topo.nodes().collect();
    shuffle(rng, &mut pool);
    for f in 0..NF {
        own[pool[f]] = f as i32;
        count[f] += 1;
    }
    let mut guard = 0;
    while count.iter().any(|&c| c < 6) && guard < 10000 {
        guard += 1;
        let mut order = [0, 1, 2, 3, 4];
        shuffle(rng, &mut order);
        for f in order {
            if count[f] >= 6 {
                continue;
            }
            let free: Vec<usize> = (0..n).filter(|&i| own[i] == FREE).collect();
            let pick = if rng.next_f64() < OWNER_SCATTER {
                free[(rng.next_f64() * free.len() as f64) as usize]
            } else {
                let mut border = Vec::new();
                for i in (0..n).filter(|&i| own[i] == f as i32) {
                    for j in topo.neighbors(i) {
                        if own[j] == FREE && !border.contains(&j) {
                            border.push(j);
                        }
                    }
                }
                let from = if border.is_empty() { &free } else { &border };
                from[(rng.next_f64() * from.len() as f64) as usize]
            };
            own[pick] = f as i32;
            count[f] += 1;
        }
    }

    let mut strength = [1; MAXN];
    for f in 0..NF {
        let owned: Vec<usize> = (0..n).filter(|&i| own[i] == f as i32).collect();
        let mut values = *pick_template(rng);
        shuffle(rng, &mut values);
        for (&node, &v) in owned.iter().zip(&values) {
            strength[node] = v;
        }
    }
    (own, strength)
}
