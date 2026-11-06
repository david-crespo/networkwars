//! Native timing and profiling target: the browser bench's search workload
//! (fixed 4000-sim searches from the first turns of seeds 1..=6, play and
//! grading mode). Prints µs/sim and a digest of every root stat.
//!   cargo run --release --example bench -- [reps=3] [seeds=6] [sims=4000]
use nw_core::{Engine, RngChoice, RulesVersion, SplitMix64};
use std::time::Instant;

fn main() {
    let arg = |i: usize, d: i32| std::env::args().nth(i).map_or(d, |s| s.parse().unwrap());
    let (reps, seeds, sims) = (arg(1, 3), arg(2, 6), arg(3, 4000));
    let mut e = Engine::new();
    let (mut secs, mut total, mut digest) = (0.0, 0i64, 0i32);
    for _ in 0..reps {
        digest = 0;
        for seed in 1..=seeds as u32 {
            let mut board = e.new_game(seed, RulesVersion::Current).board;
            for turn in 1..=4 {
                if nw_core::check_winner(&e.topo, &board).is_some() {
                    break;
                }
                for grade in [0, 1] {
                    e.search.grade = grade;
                    e.sim_rng = SplitMix64(0x12345678);
                    e.active = RngChoice::Sim;
                    let start = Instant::now();
                    e.search.begin(&e.topo, &board, turn, sims, sims, 2.5, 1).unwrap();
                    while !e.search_step(i32::MAX) {}
                    secs += start.elapsed().as_secs_f64();
                    total += e.search.sims_done() as i64;
                    for c in e.search.report() {
                        digest = digest
                            .wrapping_mul(31)
                            .wrapping_add(c.action.0 * 7 + c.visits)
                            .wrapping_add((c.q * 1e9).floor() as i32);
                    }
                }
                e.search.grade = 0;
                e.active = RngChoice::Game;
                e.end_turn(&mut board);
            }
        }
    }
    println!("{:.3}s {} sims {:.3} µs/sim digest {}", secs, total, 1e6 * secs / total as f64, digest);
}
