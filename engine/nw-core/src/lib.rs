//! Network Wars engine and open-loop UCT search: board generation, rules, bots,
//! battle, rollout and sweep-up policies, and search. Native and wasm builds do the
//! same strict IEEE arithmetic (Rust never contracts to FMA), so they agree exactly.
//!
//! Each piece of state has an owner: [`Topology`] (adjacency), [`CapTables`] (exact
//! battle DP), the two RNG streams, and [`Search`] (the tree pools and the search
//! knobs). [`Engine`] bundles one of each, which is what the C ABI crate exposes as
//! its single global instance. (The C engine this began as, since removed, kept all
//! of it in globals.)

mod battle;
mod board_gen;
mod policy;
mod rng;
mod rules;
mod search;
mod topology;

pub use battle::{BATTLE_LOG_CAP, BattleOutcome, CapTables, resolve_battle, resolve_battle_logged};
pub use board_gen::{GeneratedGame, RulesVersion, generate};
pub use policy::{ranked_best_move, rollout, sweep_best_move, sweep_certify};
pub use rng::{Mulberry32, Rng, SplitMix64};
pub use rules::{
    BotCursor, attack_legal, check_winner, end_turn, reinforce, run_bot_turn, winner_from_counts,
};
pub use search::{DeepThink, RootChild, Search, SetupError, ValueStop};
pub use topology::Topology;

pub const MAXN: usize = 64;
/// Factions: 0 = red (the player), 1..=4 bots.
pub const NF: usize = 5;
pub const WIN_NODES: i32 = 24;
pub const MAX_TURNS: i32 = 300;

pub type Faction = u8;
pub const RED: Faction = 0;

/// Ownership and army counts. Only the first `topology.n()` entries are live.
/// `owned[f]` is the set of `f`'s nodes as a bitmask; change `owner` only
/// through [`Board::set_owner`] so the two agree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Board {
    pub owner: [Faction; MAXN],
    pub strength: [i32; MAXN],
    owned: [u64; NF],
}

impl Default for Board {
    fn default() -> Self {
        Board::EMPTY
    }
}

impl Board {
    pub const EMPTY: Board = Board {
        owner: [0; MAXN],
        strength: [0; MAXN],
        owned: [0; NF],
    };

    pub fn from_slices(owner: &[i32], strength: &[i32]) -> Board {
        let mut b = Board::EMPTY;
        for (i, &f) in owner.iter().enumerate() {
            b.set_owner(i, f as Faction);
        }
        b.strength[..strength.len()].copy_from_slice(strength);
        b
    }

    pub fn write_to(&self, owner: &mut [i32], strength: &mut [i32]) {
        for (dst, &src) in owner.iter_mut().zip(&self.owner) {
            *dst = src as i32;
        }
        let n = strength.len();
        strength.copy_from_slice(&self.strength[..n]);
    }

    #[inline(always)]
    pub fn set_owner(&mut self, i: usize, f: Faction) {
        if let Some(m) = self.owned.get_mut(self.owner[i] as usize) {
            *m &= !(1 << i);
        }
        self.owner[i] = f;
        if let Some(m) = self.owned.get_mut(f as usize) {
            *m |= 1 << i;
        }
    }

    /// `f`'s nodes as a bitmask.
    #[inline(always)]
    pub fn owned(&self, f: Faction) -> u64 {
        self.owned[f as usize]
    }
}

/// The set bits of `mask`, lowest first.
#[inline(always)]
pub fn bits(mut mask: u64) -> impl Iterator<Item = usize> {
    std::iter::from_fn(move || {
        (mask != 0).then(|| {
            let i = mask.trailing_zeros() as usize;
            mask &= mask - 1;
            i
        })
    })
}

/// A RED action: attack `from -> to`, or end the turn. Packed as the original C engine
/// did (`from << 8 | to`, END = -1) so tree edges stay 4 bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Action(pub i32);

impl Action {
    pub const END: Action = Action(-1);

    #[inline]
    pub fn attack(from: usize, to: usize) -> Action {
        Action(((from << 8) | to) as i32)
    }

    /// `(from, to)` for an attack, `None` for END.
    #[inline]
    pub fn target(self) -> Option<(usize, usize)> {
        (self.0 >= 0).then_some(((self.0 >> 8) as usize, (self.0 & 0xFF) as usize))
    }
}

/// Which stream the dice come from: the seeded game stream (`use_mb32_rng`) or
/// the private search stream (`use_sim_rng`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RngChoice {
    Game,
    Sim,
}

/// One engine instance: what the original C engine held in globals.
pub struct Engine {
    pub topo: Topology,
    pub tables: CapTables,
    pub game_rng: Mulberry32,
    pub sim_rng: SplitMix64,
    pub active: RngChoice,
    pub search: Search,
}

/// Run `$body` with `$rng` bound to the engine's active stream, monomorphized
/// per stream (the original C engine used a function pointer).
#[macro_export]
macro_rules! with_rng {
    ($engine:expr, |$rng:ident| $body:expr) => {
        match $engine.active {
            $crate::RngChoice::Game => {
                let $rng = &mut $engine.game_rng;
                $body
            }
            $crate::RngChoice::Sim => {
                let $rng = &mut $engine.sim_rng;
                $body
            }
        }
    };
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Engine {
        Engine {
            topo: Topology::default(),
            tables: CapTables::new(),
            game_rng: Mulberry32(0),
            sim_rng: SplitMix64(0x12345678),
            active: RngChoice::Sim,
            search: Search::default(),
        }
    }

    /// Deal a fresh game from `seed` and switch to the game stream, positioned
    /// just past board generation.
    pub fn new_game(&mut self, seed: u32, rules: RulesVersion) -> GeneratedGame {
        self.game_rng = Mulberry32(seed);
        self.active = RngChoice::Game;
        let game = generate(&mut self.game_rng, rules);
        self.topo = game.topology.clone();
        game
    }

    pub fn end_turn(&mut self, board: &mut Board) {
        with_rng!(self, |rng| end_turn(&self.topo, rng, board))
    }

    pub fn resolve_battle(&mut self, board: &mut Board, from: usize, to: usize) {
        with_rng!(self, |rng| resolve_battle(rng, board, from, to))
    }

    pub fn run_bot_turn(&mut self, board: &mut Board, faction: Faction) {
        with_rng!(self, |rng| run_bot_turn(&self.topo, rng, board, faction))
    }

    pub fn rollout(&mut self, board: &Board, turns: i32) -> bool {
        with_rng!(self, |rng| rollout(
            &self.topo,
            &mut self.tables,
            rng,
            board,
            turns
        ))
    }

    /// Sweep playouts always use the private stream; the active choice is kept.
    pub fn sweep_certify(&mut self, board: &Board, turns: i32, trials: i32, max_losses: i32) -> i32 {
        sweep_certify(&self.topo, &mut self.sim_rng, board, turns, trials, max_losses)
    }

    pub fn search_step(&mut self, budget: i32) -> bool {
        with_rng!(self, |rng| self.search.step(
            &self.topo,
            &mut self.tables,
            rng,
            budget
        ))
    }
}
