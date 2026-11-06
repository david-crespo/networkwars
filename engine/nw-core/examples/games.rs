//! Tail-latency check: play whole games with a fixed-budget search for every
//! RED decision (top-visit move, real dice on the game stream), and report
//! each game's total and slowest search plus a digest of the moves played.
//!   cargo run --release --example games -- <sims> <seed>...
use nw_core::{Action, Engine, MAX_TURNS, RED, RngChoice, RulesVersion, SplitMix64, check_winner};
use std::time::Instant;

fn main() {
    let args: Vec<u32> = std::env::args().skip(1).map(|s| s.parse().unwrap()).collect();
    let (sims, seeds) = (args[0] as i32, &args[1..]);
    let mut e = Engine::new();
    for &seed in seeds {
        let mut board = e.new_game(seed, RulesVersion::Current).board;
        let (mut turn, mut moves, mut digest) = (1, 0u32, 0u32);
        let (mut total, mut slowest) = (0.0f64, 0.0f64);
        while check_winner(&e.topo, &board).is_none() && board.owner.iter().take(e.topo.n()).any(|&f| f == RED) && turn <= MAX_TURNS {
            e.sim_rng = SplitMix64((seed as u64) << 20 | moves as u64);
            e.active = RngChoice::Sim;
            let start = Instant::now();
            e.search.begin(&e.topo, &board, turn, sims, sims, 2.5, 1).unwrap();
            while !e.search_step(i32::MAX) {}
            let t = start.elapsed().as_secs_f64();
            (total, slowest) = (total + t, slowest.max(t));
            let mut best = (Action::END, -1);
            for c in e.search.report() {
                if c.visits > best.1 {
                    best = (c.action, c.visits);
                }
            }
            e.active = RngChoice::Game;
            match best.0.target() {
                Some((from, to)) => e.resolve_battle(&mut board, from, to),
                None => {
                    e.end_turn(&mut board);
                    turn += 1;
                }
            }
            moves += 1;
            digest = digest.wrapping_mul(31).wrapping_add(best.0.0 as u32);
        }
        let w = check_winner(&e.topo, &board).map_or(-1, |w| w as i32);
        println!("seed {seed:5}: {moves:3} moves, {turn:3} turns, winner {w:2}, total {total:8.3}s, slowest {:8.1} ms, digest {digest}", 1e3 * slowest);
    }
}
