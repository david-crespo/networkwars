//! The real decompiled battle (iterated fair-coin attrition) and the exact DP
//! of it that the rollout policy reads instead of sampling.

use crate::{Board, MAX_TURNS, Rng, WIN_NODES};

/// Main DP table size; fights with a stack at or above this use the extension.
const MAXS: usize = 160;
/// The extended table covers stacks below this (16 MiB for the two tables).
const CAP_EXTENT: usize = 1024;
/// `resolve_battle_logged` records at most this many flips.
pub const BATTLE_LOG_CAP: usize = 2 * MAXS;

/// The fight itself: two guarded attacker pre-fires, then each round the
/// attacker's coin may drop a defender and the defender's coin an attacker,
/// until `d == 0` or `a == 1`. `hit(true)` = defender lost a unit, `hit(false)`
/// = attacker lost one. Returns the final `(a, d)`.
#[inline(always)]
fn fight(rng: &mut impl Rng, mut a: i32, mut d: i32, mut hit: impl FnMut(bool)) -> (i32, i32) {
    for _ in 0..2 {
        if d > 0 && a > 1 && rng.coin() {
            d -= 1;
            hit(true);
        }
    }
    while d > 0 && a > 1 {
        if rng.coin() {
            d -= 1;
            hit(true);
        }
        if rng.coin() {
            a -= 1;
            hit(false);
        }
    }
    (a, d)
}

/// Capture iff `a > 1 && d == 0`: the occupier is `a - 1` and the source keeps
/// exactly 1. Otherwise the source is ground to 1 and the defender keeps `d`.
#[inline(always)]
fn settle(board: &mut Board, from: usize, to: usize, a: i32, d: i32) -> bool {
    let captured = a > 1 && d == 0;
    if captured {
        board.set_owner(to, board.owner[from]);
        board.strength[to] = a - 1;
    } else {
        board.strength[to] = d;
    }
    board.strength[from] = 1;
    captured
}

/// Resolve `from` attacking `to`. The caller has checked legality.
#[inline]
pub fn resolve_battle(rng: &mut impl Rng, board: &mut Board, from: usize, to: usize) {
    let (a, d) = fight(rng, board.strength[from], board.strength[to], |_| {});
    settle(board, from, to, a, d);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BattleOutcome {
    pub captured: bool,
    pub from_start: i32,
    pub to_start: i32,
}

/// `resolve_battle` that also records the loss sequence for the battle
/// animation (`flips[i]` = 1 if the defender lost a unit, 0 for the
/// attacker). Returns the outcome and the number of flips written.
pub fn resolve_battle_logged(
    rng: &mut impl Rng,
    board: &mut Board,
    from: usize,
    to: usize,
    flips: &mut [i32],
) -> (BattleOutcome, usize) {
    let (a0, d0) = (board.strength[from], board.strength[to]);
    let mut len = 0;
    let (a, d) = fight(rng, a0, d0, |defender_lost| {
        if len < BATTLE_LOG_CAP {
            flips[len] = defender_lost as i32;
            len += 1;
        }
    });
    let captured = settle(board, from, to, a, d);
    let outcome = BattleOutcome {
        captured,
        from_start: a0,
        to_start: d0,
    };
    (outcome, len)
}

#[derive(Clone, Copy, Default)]
struct CapEstimate {
    a: i32,
    d: i32,
    p: f64,
    strength: f64,
}

/// The rectangle of the main-loop DP computed so far, grown on demand for
/// fights beyond the fixed tables.
struct Extension {
    p: Vec<f64>,
    s: Vec<f64>,
}

/// Exact capture probability and expected occupier strength for every fight.
///
/// Main-loop tables (no pre-fires), for `a > 1, d > 0`:
///   `CP[a][d] = (CP[a-1][d-1] + CP[a][d-1] + CP[a-1][d]) / 3`, likewise `CS`
/// (the /3 conditions the two coins on at least one hit). `CP[a][0] = 1` and
/// `CS[a][0] = a - 1` for `a > 1`; `a <= 1` never captures. `capp`/`capes`
/// then fold in the two pre-fires; `capes` is `CS / CP`, the conditional
/// expected occupier.
pub struct CapTables {
    capp: Box<[[f64; MAXS]; MAXS]>,
    capes: Box<[[f64; MAXS]; MAXS]>,
    pub(crate) source_log: [f64; MAXS],
    large: [CapEstimate; 256],
    ext: Option<Extension>,
    ext_a: usize,
    ext_d: usize,
    tiles: Tiles,
}

impl Default for CapTables {
    fn default() -> Self {
        Self::new()
    }
}

/// Average over the four outcomes of the two pre-fires, each dropping `d` by
/// one while it is positive.
#[inline]
fn fold_prefires(d: usize, cell: impl Fn(usize) -> (f64, f64)) -> (f64, f64) {
    let (mut pp, mut ps) = (0.0, 0.0);
    for c1 in 0..2 {
        for c2 in 0..2 {
            let dd = d.saturating_sub(c1).saturating_sub(c2);
            let (p, s) = cell(dd);
            pp += 0.25 * p;
            ps += 0.25 * s;
        }
    }
    (pp, ps)
}

#[inline]
fn conditional(pp: f64, ps: f64) -> f64 {
    if pp > 0.0 { ps / pp } else { 0.0 }
}

impl CapTables {
    pub fn new() -> CapTables {
        let mut cp = vec![[0.0f64; MAXS]; MAXS];
        let mut cs = vec![[0.0f64; MAXS]; MAXS];
        let mut source_log = [0.0; MAXS];
        for a in 0..MAXS {
            source_log[a] = (a.max(2) as f64).log2();
            if a > 1 {
                cp[a][0] = 1.0;
                cs[a][0] = (a - 1) as f64;
            }
        }
        for a in 2..MAXS {
            for d in 1..MAXS {
                cp[a][d] = (cp[a - 1][d - 1] + cp[a][d - 1] + cp[a - 1][d]) / 3.0;
                cs[a][d] = (cs[a - 1][d - 1] + cs[a][d - 1] + cs[a - 1][d]) / 3.0;
            }
        }
        let mut capp = Box::new([[0.0; MAXS]; MAXS]);
        let mut capes = Box::new([[0.0; MAXS]; MAXS]);
        for a in 2..MAXS {
            for d in 0..MAXS {
                let (pp, ps) = fold_prefires(d, |dd| (cp[a][dd], cs[a][dd]));
                capp[a][d] = pp;
                capes[a][d] = conditional(pp, ps);
            }
        }
        CapTables {
            capp,
            capes,
            source_log,
            large: [CapEstimate::default(); 256],
            ext: None,
            ext_a: 1,
            ext_d: 0,
            tiles: Tiles::default(),
        }
    }

    #[inline]
    pub fn capture_prob(&mut self, a: i32, d: i32) -> f64 {
        if a <= 1 {
            return 0.0;
        }
        if d < 1 {
            return 1.0;
        }
        if a as usize >= MAXS || d as usize >= MAXS {
            return self.large_estimate(a, d).p;
        }
        self.capp[a as usize][d as usize]
    }

    #[inline]
    pub fn expected_occupier(&mut self, a: i32, d: i32) -> f64 {
        if a <= 1 {
            return 0.0;
        }
        if d < 1 {
            return (a - 1) as f64;
        }
        if a as usize >= MAXS || d as usize >= MAXS {
            return self.large_estimate(a, d).strength;
        }
        self.capes[a as usize][d as usize]
    }

    /// Large stacks must not be clamped: 400 vs 160 is nothing like 159 vs
    /// 159. Use the extended exact DP, then the tiles past its bound, then two
    /// rolling rows past theirs, behind a small pair cache.
    #[cold]
    fn large_estimate(&mut self, a: i32, d: i32) -> CapEstimate {
        let key = ((a as u32).wrapping_mul(131).wrapping_add(d as u32) % 256) as usize;
        let cached = self.large[key];
        if cached.a == a && cached.d == d {
            return cached;
        }
        let (au, du) = (a as usize, d as usize);
        let (pp, ps) = if self.extend(au, du) {
            let ext = self.ext.as_ref().unwrap();
            let row = au * CAP_EXTENT;
            fold_prefires(du, |dd| (ext.p[row + dd], ext.s[row + dd]))
        } else if let Some(rows) = self.tiles.fold(au, du) {
            rows
        } else if let Some(rows) = two_row_dp(au, du) {
            rows
        } else {
            // Bounded approximation, only if even two rows cannot be allocated.
            let (ca, cd) = (au.min(MAXS - 1), du.min(MAXS - 1));
            return CapEstimate {
                a,
                d,
                p: self.capp[ca][cd],
                strength: self.capes[ca][cd],
            };
        };
        let estimate = CapEstimate {
            a,
            d,
            p: pp,
            strength: conditional(pp, ps),
        };
        self.large[key] = estimate;
        estimate
    }

    /// Grow the extended rectangle to cover `(a, d)` in blocks of 64. Returns
    /// false if it is out of range or cannot be allocated.
    fn extend(&mut self, a: usize, d: usize) -> bool {
        if a >= CAP_EXTENT || d >= CAP_EXTENT {
            return false;
        }
        if a <= self.ext_a && d <= self.ext_d {
            return true;
        }
        if self.ext.is_none() {
            let (Some(p), Some(s)) = (zeroed(CAP_EXTENT * CAP_EXTENT), zeroed(CAP_EXTENT * CAP_EXTENT))
            else {
                return false;
            };
            self.ext = Some(Extension { p, s });
        }
        let (old_a, old_d) = (self.ext_a, self.ext_d);
        let na = if a > old_a { a | 63 } else { old_a };
        let nd = if d > old_d { d | 63 } else { old_d };
        let ext = self.ext.as_mut().unwrap();
        for aa in 2..=na {
            let row = aa * CAP_EXTENT;
            let prev = row - CAP_EXTENT;
            ext.p[row] = 1.0;
            ext.s[row] = (aa - 1) as f64;
            let start = if aa > old_a { 1 } else { old_d + 1 };
            for dd in start..=nd {
                ext.p[row + dd] = (ext.p[prev + dd - 1] + ext.p[row + dd - 1] + ext.p[prev + dd]) / 3.0;
                ext.s[row + dd] = (ext.s[prev + dd - 1] + ext.s[row + dd - 1] + ext.s[prev + dd]) / 3.0;
            }
        }
        (self.ext_a, self.ext_d) = (na, nd);
        true
    }
}

fn zeroed(len: usize) -> Option<Vec<f64>> {
    let mut v = Vec::new();
    v.try_reserve_exact(len).ok()?;
    v.resize(len, 0.0);
    Some(v)
}

/// Tile side, in cells.
const TILE: usize = 64;
/// The largest stack a game can build by the turn horizon: a dealt 8, then a
/// full 23-node budget on one node every turn. A lockstep border, where
/// neither side ever attacks, stalls rollouts at the horizon with stacks this
/// high, so the tiles must reach it or each RED turn reruns the two-row DP.
const HORIZON_STACK: usize = 8 + (WIN_NODES as usize - 1) * MAX_TURNS as usize;
/// Tiles per side at most: stacks up to 6912, 23 MiB of edges.
const MAX_TILES: usize = HORIZON_STACK / TILE + 1;

type Cell = (f64, f64);

/// Column 0 of the main-loop DP: `a > 1` captures with `a - 1` left.
#[inline]
fn column0(a: usize) -> Cell {
    if a > 1 { (1.0, (a - 1) as f64) } else { (0.0, 0.0) }
}

/// One tile's last row and last column of the main-loop DP.
#[derive(Clone)]
struct Tile {
    bottom: [Cell; TILE],
    right: [Cell; TILE],
}

/// The main-loop DP past the extended table, exact and in little memory:
/// tile `(i, j)` covers attackers `2 + i * TILE ..` and defenders
/// `1 + j * TILE ..`, and keeps only its last row and column. Any cell is
/// recomputed from its tile's top and left neighbors' edges, by the same
/// recurrence in the same order, so it is bit-identical to the rolling rows.
#[derive(Default)]
struct Tiles {
    /// `rows[i][j]`; all rows have the same length.
    rows: Vec<Vec<Tile>>,
}

impl Tiles {
    /// Run the recurrence over rows `2 + i * TILE ..= a` and the first `w`
    /// columns of tile `(i, j)`, calling `on_row(r, row)` with each row
    /// (`row[c]` is column `j * TILE + c`, so `row[0]` is the left edge).
    fn sweep(&self, i: usize, j: usize, a: usize, w: usize, mut on_row: impl FnMut(usize, &[Cell; TILE + 1])) {
        let a0 = 2 + i * TILE;
        // Row a0 - 1: the edge of the tile above, or the all-zero row 1.
        let mut prev = [(0.0, 0.0); TILE + 1];
        if i > 0 {
            prev[1..=w].copy_from_slice(&self.rows[i - 1][j].bottom[..w]);
            prev[0] = if j > 0 { self.rows[i - 1][j - 1].bottom[TILE - 1] } else { column0(a0 - 1) };
        }
        let mut cur = [(0.0, 0.0); TILE + 1];
        for r in 0..=a - a0 {
            cur[0] = if j > 0 { self.rows[i][j - 1].right[r] } else { column0(a0 + r) };
            for c in 1..=w {
                cur[c].0 = (prev[c - 1].0 + cur[c - 1].0 + prev[c].0) / 3.0;
                cur[c].1 = (prev[c - 1].1 + cur[c - 1].1 + prev[c].1) / 3.0;
            }
            on_row(r, &cur);
            prev = cur;
        }
    }

    /// Compute every tile up to `(i, j)`. False if that is past the cap or
    /// cannot be allocated.
    fn cover(&mut self, i: usize, j: usize) -> bool {
        if i >= MAX_TILES || j >= MAX_TILES {
            return false;
        }
        let (n_rows, n_cols) = (self.rows.len(), self.rows.first().map_or(0, Vec::len));
        let (want_rows, want_cols) = (n_rows.max(i + 1), n_cols.max(j + 1));
        if self.rows.try_reserve(want_rows - n_rows).is_err() {
            return false;
        }
        for ii in 0..want_rows {
            if ii == self.rows.len() {
                self.rows.push(Vec::new());
            }
            let have = self.rows[ii].len();
            if self.rows[ii].try_reserve_exact(want_cols - have).is_err() {
                return false;
            }
            for jj in have..want_cols {
                let mut tile = Tile {
                    bottom: [(0.0, 0.0); TILE],
                    right: [(0.0, 0.0); TILE],
                };
                self.sweep(ii, jj, 2 + ii * TILE + TILE - 1, TILE, |r, row| {
                    tile.right[r] = row[TILE];
                    if r == TILE - 1 {
                        tile.bottom.copy_from_slice(&row[1..]);
                    }
                });
                self.rows[ii].push(tile);
            }
        }
        true
    }

    /// Row `a` of the main-loop DP over columns `d - 2 ..= d`, pre-fires
    /// folded, or `None` past the cap. Needs `a >= 2`, `d >= 1`.
    fn fold(&mut self, a: usize, d: usize) -> Option<(f64, f64)> {
        let i = (a - 2) / TILE;
        let tile_of = |dd: usize| (dd - 1) / TILE;
        if !self.cover(i, tile_of(d)) {
            return None;
        }
        // The needed columns lie in at most two tiles.
        let mut cells = [(0.0, 0.0); 3];
        let mut done = 0;
        for k in 0..3 {
            let dd = d.saturating_sub(k);
            if dd == 0 {
                cells[k] = column0(a);
            } else if done <= k {
                let j = tile_of(dd);
                let w = dd - j * TILE;
                self.sweep(i, j, a, w, |r, row| {
                    if r == a - 2 - i * TILE {
                        // Fill every needed column this tile holds.
                        for kk in k..3 {
                            let c = d.saturating_sub(kk);
                            if c > j * TILE && c <= j * TILE + w {
                                cells[kk] = row[c - j * TILE];
                                done = kk + 1;
                            }
                        }
                    }
                });
            }
        }
        Some(fold_prefires(d, |dd| cells[d - dd]))
    }
}

/// The main-loop DP for one `(a, d)` in two rolling rows, pre-fires folded.
fn two_row_dp(a: usize, d: usize) -> Option<(f64, f64)> {
    let width = d + 1;
    let mut prev_p = zeroed(width)?;
    let mut next_p = zeroed(width)?;
    let mut prev_s = zeroed(width)?;
    let mut next_s = zeroed(width)?;
    for aa in 2..=a {
        next_p[0] = 1.0;
        next_s[0] = (aa - 1) as f64;
        for dd in 1..=d {
            next_p[dd] = (prev_p[dd - 1] + next_p[dd - 1] + prev_p[dd]) / 3.0;
            next_s[dd] = (prev_s[dd - 1] + next_s[dd - 1] + prev_s[dd]) / 3.0;
        }
        std::mem::swap(&mut prev_p, &mut next_p);
        std::mem::swap(&mut prev_s, &mut next_s);
    }
    Some(fold_prefires(d, |dd| (prev_p[dd], prev_s[dd])))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tiles must match the rolling rows bit for bit, including at tile
    /// edges and column 0.
    #[test]
    fn tiles_match_rolling_rows() {
        let mut tiles = Tiles::default();
        let edges = [2, 3, 4, 65, 66, 67, 129, 130, 1023, 1024, 1025, 1500];
        let mut pairs: Vec<(usize, usize)> = Vec::new();
        for &a in &edges {
            for d in [1, 2, 3, 63, 64, 65, 66, 128, 129, 130, 700, 1024, 1029, 1441] {
                pairs.push((a, d));
            }
        }
        let mut x = 12345u64;
        for _ in 0..200 {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            pairs.push((2 + (x >> 33) as usize % 1600, 1 + (x >> 13) as usize % 1600));
        }
        // A lockstep border near the turn horizon (seed 1261).
        pairs.push((4456, 4471));
        for (a, d) in pairs {
            let (p, s) = tiles.fold(a, d).unwrap();
            let (wp, ws) = two_row_dp(a, d).unwrap();
            assert_eq!((p.to_bits(), s.to_bits()), (wp.to_bits(), ws.to_bits()), "at {a} vs {d}");
        }
    }

    /// Large-stack estimates match the main tables where they overlap, and
    /// the two-row DP exactly past them: growing each dimension separately
    /// and together, revisiting cells, and crossing the extension's bound.
    #[test]
    fn large_estimates_are_exact() {
        let mut t = CapTables::new();
        assert_eq!(t.capture_prob(1, 0), 0.0);
        assert_eq!(t.capture_prob(2, 0), 1.0);
        assert!((t.capture_prob(2, 1) - 5.0 / 6.0).abs() < 1e-12);
        for a in (2..MAXS).step_by(13) {
            for d in (1..MAXS).step_by(17) {
                let e = t.large_estimate(a as i32, d as i32);
                assert!((e.p - t.capp[a][d]).abs() < 1e-12);
                assert!((e.strength - t.capes[a][d]).abs() < 1e-10);
            }
        }
        let pairs = [
            (160, 1),
            (180, 200),
            (400, 160),
            (160, 400),
            (511, 511),
            (700, 900),
            (1023, 1023),
            (160, 200),
            (1024, 160),
            (160, 1024),
            (1400, 1100),
        ];
        for (a, d) in pairs {
            let e = t.large_estimate(a as i32, d as i32);
            let (pp, ps) = two_row_dp(a, d).unwrap();
            assert_eq!((e.p, e.strength), (pp, conditional(pp, ps)), "({a}, {d})");
        }
        assert!(t.capture_prob(400, 160) > 0.999999);
        assert!(t.capture_prob(160, 400) < 0.000001);
        assert_eq!(t.expected_occupier(400, 0), 399.0);
        assert!(t.expected_occupier(400, 1) > 397.0);
    }
}
