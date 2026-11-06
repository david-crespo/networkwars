//! Golden traces through the C ABI. Each test drives the engine through a
//! scripted call sequence and records everything observable (boards, battle
//! logs, the bot cursor, rollouts, sweep-up, search roots, RNG positions),
//! then compares a digest of that trace with a frozen value. They cover what
//! the solver/ gates don't: legacy board-gen, random legal play through every
//! primitive, the bot cursor, sweep-up, large stacks (past both DP tables),
//! disconnected imports, and the optional search stops.
//!
//! The digests were frozen while these same traces matched the C reference
//! engine (solver/fast_engine.c, since removed) entry for entry. A change that
//! moves a digest changes the game or the search: if it's meant to, update the
//! digest and say so in the commit. To find where two revisions diverge, set
//! NW_TRACE_DIR to write each test's full trace there, run both, and diff.

use std::ffi::c_int;

use nw_engine::*;

type P = *mut c_int;

/// Test-side randomness for choosing actions (not the engine's dice).
struct XorShift(u64);

impl XorShift {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n as u64) as usize
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Game {
    n: usize,
    owner: Vec<c_int>,
    strength: Vec<c_int>,
    adj: Vec<Vec<usize>>,
}

/// Everything observable about a run, one entry per step.
#[derive(Default)]
struct Trace(Vec<String>);

impl Trace {
    fn log(&mut self, s: impl Into<String>) {
        self.0.push(s.into());
    }

    fn new_game(&mut self, seed: u32, legacy: bool) -> Game {
        let mut owner = vec![0; 64];
        let mut strength = vec![0; 64];
        let (mut x, mut y) = (vec![0; 64], vec![0; 64]);
        let f: unsafe extern "C" fn(u32, P, P, P, P) -> c_int =
            if legacy { new_game_legacy } else { new_game };
        let n = unsafe {
            f(
                seed,
                owner.as_mut_ptr(),
                strength.as_mut_ptr(),
                x.as_mut_ptr(),
                y.as_mut_ptr(),
            )
        } as usize;
        let (mut off, mut list, mut links) = (vec![0; 65], vec![0; 512], vec![0; 1024]);
        unsafe { get_adj(off.as_mut_ptr(), list.as_mut_ptr()) };
        let nl = unsafe { get_links(links.as_mut_ptr()) } as usize;
        let mb = get_rng_mb32();
        self.log(format!(
            "game {seed} n={n} owner={:?} strength={:?} x={:?} y={:?} off={:?} list={:?} links={:?} mb={mb}",
            &owner[..n],
            &strength[..n],
            &x[..n],
            &y[..n],
            &off[..=n],
            &list[..off[n] as usize],
            &links[..2 * nl]
        ));
        let adj = (0..n)
            .map(|i| {
                list[off[i] as usize..off[i + 1] as usize]
                    .iter()
                    .map(|&j| j as usize)
                    .collect()
            })
            .collect();
        owner.truncate(n);
        strength.truncate(n);
        Game {
            n,
            owner,
            strength,
            adj,
        }
    }

    fn board(&mut self, g: &Game, what: &str) {
        let w = unsafe { ext_check_winner(g.owner.as_ptr()) };
        self.log(format!(
            "{what}: owner={:?} strength={:?} winner={w}",
            g.owner, g.strength
        ));
    }

    fn search(&mut self, g: &mut Game, turns: c_int, min: c_int, max: c_int, nroll: c_int) {
        let (mut acts, mut visits, mut q) = (vec![0; 1024], vec![0; 1024], vec![0.0; 1024]);
        let (o, s) = (g.owner.as_mut_ptr(), g.strength.as_mut_ptr());
        let nc = unsafe {
            uct_search(
                o,
                s,
                turns,
                min,
                max,
                2.5,
                nroll,
                acts.as_mut_ptr(),
                visits.as_mut_ptr(),
                q.as_mut_ptr(),
            )
        } as usize;
        let sims = uct_sims_done();
        self.log(format!(
            "search nc={nc} sims={sims} acts={:?} visits={:?} q={:?}",
            &acts[..nc],
            &visits[..nc],
            q[..nc].iter().map(|v: &f64| v.to_bits()).collect::<Vec<_>>()
        ));
    }
}

/// Run `script`, then check the trace's length and FNV-1a digest against `golden`.
fn golden(name: &str, seed: u64, golden: (usize, u64), mut script: impl FnMut(&mut Trace, &mut XorShift)) {
    let mut trace = Trace::default();
    script(
        &mut trace,
        &mut XorShift(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1),
    );
    if let Some(dir) = std::env::var_os("NW_TRACE_DIR") {
        let path = std::path::Path::new(&dir).join(format!("{name}.txt"));
        std::fs::write(&path, trace.0.join("\n") + "\n").unwrap();
    }
    let mut digest = 0xcbf29ce484222325u64;
    for byte in trace.0.iter().flat_map(|e| e.bytes().chain([b'\n'])) {
        digest = (digest ^ byte as u64).wrapping_mul(0x100000001b3);
    }
    assert_eq!(
        (trace.0.len(), digest),
        golden,
        "{name}: trace (entries, digest) changed"
    );
}

#[test]
fn board_gen_both_versions() {
    golden(
        "board_gen_both_versions",
        1,
        (6000, 0xfc311e0dc233d420),
        |t, _| {
            for seed in 0..3000u32 {
                t.new_game(seed.wrapping_mul(2654435761), false);
                t.new_game(seed, true);
            }
        },
    );
}

fn red_attacks(g: &Game) -> Vec<(usize, usize)> {
    let mut out = vec![];
    for i in 0..g.n {
        if g.owner[i] == 0 && g.strength[i] > 1 {
            out.extend(g.adj[i].iter().filter(|&&j| g.owner[j] != 0).map(|&j| (i, j)));
        }
    }
    out
}

/// Random legal play through every primitive, on the game stream.
fn random_play(t: &mut Trace, rng: &mut XorShift, g: &mut Game, steps: usize, stepwise_bots: bool) {
    let (mut flips, mut len, mut meta) = (vec![0; 400], 0, vec![0; 5]);
    for step in 0..steps {
        let (o, s) = (g.owner.as_mut_ptr(), g.strength.as_mut_ptr());
        if unsafe { ext_check_winner(o) } >= 0 {
            break;
        }
        let attacks = red_attacks(g);
        let choice = rng.below(attacks.len() + 2);
        if choice < attacks.len() {
            let (from, to) = attacks[choice];
            if step % 2 == 0 {
                unsafe {
                    resolve_battle_logged(
                        o,
                        s,
                        from as c_int,
                        to as c_int,
                        flips.as_mut_ptr(),
                        &mut len,
                        meta.as_mut_ptr(),
                    )
                };
                t.log(format!(
                    "logged {from}->{to} flips={:?} meta={meta:?}",
                    &flips[..len as usize]
                ));
            } else {
                unsafe { ext_resolve_battle(o, s, from as c_int, to as c_int) };
            }
        } else if choice == attacks.len() {
            // An illegal request: rejected with no dice consumed.
            let (from, to) = (rng.below(g.n), rng.below(g.n));
            let legal = unsafe { ext_attack_legal(o, s, from as c_int, to as c_int) };
            unsafe {
                resolve_battle_logged(
                    o,
                    s,
                    from as c_int,
                    to as c_int,
                    flips.as_mut_ptr(),
                    &mut len,
                    meta.as_mut_ptr(),
                )
            };
            t.log(format!("probe {from}->{to} legal={legal} meta={meta:?}"));
        } else if stepwise_bots {
            unsafe { ext_reinforce(o, s, 0) };
            for bot in 1..5 {
                let mut st = vec![0; 67];
                unsafe { bot_turn_begin(o, s, bot, st.as_mut_ptr()) };
                t.log(format!("cursor {bot} {st:?}"));
                if unsafe { ext_check_winner(o) } >= 0 {
                    break;
                }
                loop {
                    let mv = unsafe { bot_turn_next(o, s, bot, st.as_mut_ptr()) };
                    t.log(format!("bot {bot} next={mv} st={:?}", &st[..3]));
                    if mv == 0 {
                        unsafe { ext_reinforce(o, s, bot) };
                        break;
                    }
                    let mv = mv - 1;
                    unsafe { ext_resolve_battle(o, s, mv >> 8, mv & 0xFF) };
                }
            }
        } else {
            unsafe { end_turn(o, s) };
        }
        t.board(g, "step");
        t.log(format!("mb={}", get_rng_mb32()));
    }
}

#[test]
fn random_legal_play() {
    golden("random_legal_play", 2, (57800, 0x11173abe2f6e47ae), |t, rng| {
        for seed in 1..=400u32 {
            let legacy = seed % 5 == 0;
            let mut g = t.new_game(seed, legacy);
            random_play(t, rng, &mut g, 300, seed % 3 == 0);
        }
    });
}

#[test]
fn rollouts_and_sweep() {
    golden("rollouts_and_sweep", 3, (11582, 0x3388180b669bda26), |t, rng| {
        for seed in 1..=150u32 {
            let mut g = t.new_game(seed, false);
            let steps = 20 + rng.below(40);
            random_play(t, rng, &mut g, steps, false);
            let (o, s) = (g.owner.as_mut_ptr(), g.strength.as_mut_ptr());
            set_sim_seed(seed as u64 * 7919);
            use_sim_rng();
            let rolls: Vec<_> = (0..40).map(|_| unsafe { rollout(o, s, 3) }).collect();
            let sweep = unsafe { sweep_best_move(o, s) };
            use_mb32_rng();
            let cert = unsafe { sweep_certify(o, s, 3, 200, 5) };
            let mb = get_rng_mb32();
            t.log(format!("rolls={rolls:?} sweep={sweep} cert={cert} mb={mb}"));
        }
    });
}

/// Stacks past the 160 table and past the 1024 extension.
#[test]
fn large_stacks() {
    golden("large_stacks", 4, (1669, 0xf4088ef928240b16), |t, rng| {
        for seed in 1..=60u32 {
            let mut g = t.new_game(seed, false);
            random_play(t, rng, &mut g, 10, false);
            // A few big stacks per board: past the 160 table, and (rarely) past
            // the 1024 extension, where each estimate is a full two-row DP.
            for _ in 0..3 {
                let i = rng.below(g.n);
                g.strength[i] = match rng.below(5) {
                    0 => 1100 + rng.below(200) as c_int,
                    1 | 2 => 160 + rng.below(300) as c_int,
                    _ => 400 + rng.below(600) as c_int,
                };
            }
            set_sim_seed(seed as u64);
            use_sim_rng();
            let (o, s) = (g.owner.as_mut_ptr(), g.strength.as_mut_ptr());
            let rolls: Vec<_> = (0..4).map(|_| unsafe { rollout(o, s, 297) }).collect();
            t.log(format!("rolls={rolls:?}"));
            uct_set_grade(0);
            t.search(&mut g, 298, 64, 64, 1);
        }
    });
}

/// Drop random links so factions split into components, some borderless.
#[test]
fn disconnected_imports() {
    golden(
        "disconnected_imports",
        5,
        (36596, 0xe5986ade2c575d5c),
        |t, rng| {
            for seed in 1..=300u32 {
                let g0 = t.new_game(seed, false);
                let mut adj = g0.adj.clone();
                for i in 0..g0.n {
                    for j in g0.adj[i].clone() {
                        if i < j && rng.below(3) == 0 {
                            adj[i].retain(|&k| k != j);
                            adj[j].retain(|&k| k != i);
                        }
                    }
                }
                let mut off = vec![0];
                let mut list = vec![];
                for nbs in &adj {
                    list.extend(nbs.iter().map(|&j| j as c_int));
                    off.push(list.len() as c_int);
                }
                unsafe { set_topology(adj.len() as c_int, off.as_ptr(), list.as_ptr()) };
                let mut g = Game { adj, ..g0 };
                for f in 0..5 {
                    unsafe { ext_reinforce(g.owner.as_mut_ptr(), g.strength.as_mut_ptr(), f) };
                    t.board(&g, "reinforce");
                }
                set_rng_mb32(seed.wrapping_mul(977));
                use_mb32_rng();
                for bot in 1..5 {
                    unsafe { ext_run_bot_turn(g.owner.as_mut_ptr(), g.strength.as_mut_ptr(), bot) };
                    t.board(&g, "bot turn");
                }
                random_play(t, rng, &mut g, 30, seed % 2 == 0);
            }
        },
    );
}

/// Value stop, deep-think, grading modes, nroll > 1, and chunked vs one-shot.
#[test]
fn search_variants() {
    golden("search_variants", 6, (278, 0x93309c122129e65d), |t, rng| {
        for seed in 1..=10u32 {
            let mut g = t.new_game(seed, false);
            let steps = rng.below(15);
            random_play(t, rng, &mut g, steps, false);
            if unsafe { ext_check_winner(g.owner.as_mut_ptr()) } >= 0 {
                continue;
            }
            set_sim_seed(0x12345678);
            use_sim_rng();
            match seed % 4 {
                0 => uct_set_value_stop(0.03, 0.97, 0.15, 512),
                1 => uct_set_deepthink(4.0, 600, 0.6),
                2 => uct_set_grade(2),
                _ => uct_set_grade(1),
            }
            t.search(&mut g, 2, 1500, 6000, 1 + (seed % 2) as c_int);
            // Chunked, reading the root between chunks.
            let (o, s) = (g.owner.as_mut_ptr(), g.strength.as_mut_ptr());
            unsafe { uct_begin(o, s, 2, 1000, 3000, 2.5, 1) };
            let (mut acts, mut visits, mut q) = (vec![0; 1024], vec![0; 1024], vec![0.0; 1024]);
            loop {
                let done = uct_step(333);
                let nc =
                    unsafe { uct_report(acts.as_mut_ptr(), visits.as_mut_ptr(), q.as_mut_ptr()) } as usize;
                t.log(format!(
                    "chunk done={done} acts={:?} visits={:?} q={:?}",
                    &acts[..nc],
                    &visits[..nc],
                    q[..nc].iter().map(|v| v.to_bits()).collect::<Vec<_>>()
                ));
                if done != 0 {
                    break;
                }
            }
            uct_set_value_stop(-1.0, 2.0, 2.0, 1 << 30);
            uct_set_deepthink(0.0, 1 << 30, 2.0);
            uct_set_grade(0);
        }
    });
}
