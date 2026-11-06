//! The real decompiled battle (iterated fair-coin attrition) and the exact DP
//! of it that the rollout policy reads instead of sampling.

use crate::{Board, Rng};

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
        board.owner[to] = board.owner[from];
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
    /// 159. Use the extended exact DP, or two rolling rows past its bound,
    /// behind a small pair cache.
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
