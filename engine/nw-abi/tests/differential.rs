//! Differential tests: the Rust ABI against the C engine, loaded with
//! libloading, on identical call sequences. They cover what the solver/
//! benches don't: legacy board-gen, random legal play through every
//! primitive, the bot cursor, sweep-up, large stacks (past both DP tables),
//! disconnected imports, and the optional search stops.
//!
//! The C build must be strict IEEE without FMA contraction (clang contracts
//! `a += b * c` by default; Rust never does):
//!   cc -O3 -ffp-contract=off -shared -fPIC solver/fast_engine.c -o engine/target/c/fast_engine_nocontract.so
//! Override the path with NW_C_ENGINE.

use std::ffi::{c_double, c_int};
use std::path::PathBuf;

type P = *mut c_int;
type C = *const c_int;

/// The C ABI as a table of function pointers, so both engines run the same code.
struct Api {
    set_topology: unsafe extern "C" fn(c_int, *const c_int, *const c_int),
    get_adj: unsafe extern "C" fn(P, P) -> c_int,
    get_links: unsafe extern "C" fn(P) -> c_int,
    set_rng_mb32: unsafe extern "C" fn(u32),
    get_rng_mb32: unsafe extern "C" fn() -> u32,
    set_sim_seed: unsafe extern "C" fn(u64),
    use_mb32_rng: unsafe extern "C" fn(),
    use_sim_rng: unsafe extern "C" fn(),
    new_game: unsafe extern "C" fn(u32, P, P, P, P) -> c_int,
    new_game_legacy: unsafe extern "C" fn(u32, P, P, P, P) -> c_int,
    ext_attack_legal: unsafe extern "C" fn(C, C, c_int, c_int) -> c_int,
    resolve_battle_logged: unsafe extern "C" fn(P, P, c_int, c_int, P, P, P),
    ext_resolve_battle: unsafe extern "C" fn(P, P, c_int, c_int),
    bot_turn_begin: unsafe extern "C" fn(C, C, c_int, P),
    bot_turn_next: unsafe extern "C" fn(C, C, c_int, P) -> c_int,
    ext_run_bot_turn: unsafe extern "C" fn(P, P, c_int),
    ext_reinforce: unsafe extern "C" fn(P, P, c_int),
    end_turn: unsafe extern "C" fn(P, P),
    ext_check_winner: unsafe extern "C" fn(C) -> c_int,
    sweep_best_move: unsafe extern "C" fn(C, C) -> c_int,
    sweep_certify: unsafe extern "C" fn(C, C, c_int, c_int, c_int) -> c_int,
    rollout: unsafe extern "C" fn(C, C, c_int) -> c_int,
    uct_set_grade: unsafe extern "C" fn(c_int),
    uct_set_value_stop: unsafe extern "C" fn(c_double, c_double, c_double, c_int),
    uct_set_deepthink: unsafe extern "C" fn(c_double, c_int, c_double),
    uct_begin: unsafe extern "C" fn(C, C, c_int, c_int, c_int, c_double, c_int) -> c_int,
    uct_step: unsafe extern "C" fn(c_int) -> c_int,
    uct_report: unsafe extern "C" fn(P, P, *mut c_double) -> c_int,
    uct_sims_done: unsafe extern "C" fn() -> c_int,
    uct_search:
        unsafe extern "C" fn(C, C, c_int, c_int, c_int, c_double, c_int, P, P, *mut c_double) -> c_int,
}

macro_rules! api {
    ($get:expr) => {
        Api {
            set_topology: $get("set_topology"),
            get_adj: $get("get_adj"),
            get_links: $get("get_links"),
            set_rng_mb32: $get("set_rng_mb32"),
            get_rng_mb32: $get("get_rng_mb32"),
            set_sim_seed: $get("set_sim_seed"),
            use_mb32_rng: $get("use_mb32_rng"),
            use_sim_rng: $get("use_sim_rng"),
            new_game: $get("new_game"),
            new_game_legacy: $get("new_game_legacy"),
            ext_attack_legal: $get("ext_attack_legal"),
            resolve_battle_logged: $get("resolve_battle_logged"),
            ext_resolve_battle: $get("ext_resolve_battle"),
            bot_turn_begin: $get("bot_turn_begin"),
            bot_turn_next: $get("bot_turn_next"),
            ext_run_bot_turn: $get("ext_run_bot_turn"),
            ext_reinforce: $get("ext_reinforce"),
            end_turn: $get("end_turn"),
            ext_check_winner: $get("ext_check_winner"),
            sweep_best_move: $get("sweep_best_move"),
            sweep_certify: $get("sweep_certify"),
            rollout: $get("rollout"),
            uct_set_grade: $get("uct_set_grade"),
            uct_set_value_stop: $get("uct_set_value_stop"),
            uct_set_deepthink: $get("uct_set_deepthink"),
            uct_begin: $get("uct_begin"),
            uct_step: $get("uct_step"),
            uct_report: $get("uct_report"),
            uct_sims_done: $get("uct_sims_done"),
            uct_search: $get("uct_search"),
        }
    };
}

fn c_api() -> Api {
    let path = std::env::var_os("NW_C_ENGINE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/c/fast_engine_nocontract.so")
        });
    // Leaked: the functions must outlive every test in this process.
    let lib: &'static libloading::Library = Box::leak(Box::new(
        unsafe { libloading::Library::new(&path) }.unwrap_or_else(|e| panic!("load {}: {e}", path.display())),
    ));
    unsafe fn sym<T: Copy>(lib: &'static libloading::Library, name: &str) -> T {
        unsafe { *lib.get::<T>(name.as_bytes()).unwrap() }
    }
    api!(|name| unsafe { sym(lib, name) })
}

fn rust_api() -> Api {
    use nw_engine::*;
    macro_rules! f {
        ($name:ident) => {
            $name as _
        };
    }
    Api {
        set_topology: f!(set_topology),
        get_adj: f!(get_adj),
        get_links: f!(get_links),
        set_rng_mb32: f!(set_rng_mb32),
        get_rng_mb32: f!(get_rng_mb32),
        set_sim_seed: f!(set_sim_seed),
        use_mb32_rng: f!(use_mb32_rng),
        use_sim_rng: f!(use_sim_rng),
        new_game: f!(new_game),
        new_game_legacy: f!(new_game_legacy),
        ext_attack_legal: f!(ext_attack_legal),
        resolve_battle_logged: f!(resolve_battle_logged),
        ext_resolve_battle: f!(ext_resolve_battle),
        bot_turn_begin: f!(bot_turn_begin),
        bot_turn_next: f!(bot_turn_next),
        ext_run_bot_turn: f!(ext_run_bot_turn),
        ext_reinforce: f!(ext_reinforce),
        end_turn: f!(end_turn),
        ext_check_winner: f!(ext_check_winner),
        sweep_best_move: f!(sweep_best_move),
        sweep_certify: f!(sweep_certify),
        rollout: f!(rollout),
        uct_set_grade: f!(uct_set_grade),
        uct_set_value_stop: f!(uct_set_value_stop),
        uct_set_deepthink: f!(uct_set_deepthink),
        uct_begin: f!(uct_begin),
        uct_step: f!(uct_step),
        uct_report: f!(uct_report),
        uct_sims_done: f!(uct_sims_done),
        uct_search: f!(uct_search),
    }
}

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

/// Everything observable about one engine's side of a step.
type Trace = Vec<String>;

struct Side {
    api: Api,
    trace: Trace,
}

impl Side {
    fn log(&mut self, s: impl Into<String>) {
        self.trace.push(s.into());
    }

    fn new_game(&mut self, seed: u32, legacy: bool) -> Game {
        let mut owner = vec![0; 64];
        let mut strength = vec![0; 64];
        let (mut x, mut y) = (vec![0; 64], vec![0; 64]);
        let f = if legacy {
            self.api.new_game_legacy
        } else {
            self.api.new_game
        };
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
        unsafe { (self.api.get_adj)(off.as_mut_ptr(), list.as_mut_ptr()) };
        let nl = unsafe { (self.api.get_links)(links.as_mut_ptr()) } as usize;
        let mb = unsafe { (self.api.get_rng_mb32)() };
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

    fn set_topology(&mut self, adj: &[Vec<usize>]) {
        let mut off = vec![0];
        let mut list = vec![];
        for nbs in adj {
            list.extend(nbs.iter().map(|&j| j as c_int));
            off.push(list.len() as c_int);
        }
        unsafe { (self.api.set_topology)(adj.len() as c_int, off.as_ptr(), list.as_ptr()) };
    }

    fn board(&mut self, g: &Game, what: &str) {
        let w = unsafe { (self.api.ext_check_winner)(g.owner.as_ptr()) };
        self.log(format!(
            "{what}: owner={:?} strength={:?} winner={w}",
            g.owner, g.strength
        ));
    }

    fn search(&mut self, g: &mut Game, turns: c_int, min: c_int, max: c_int, nroll: c_int) {
        let (mut acts, mut visits, mut q) = (vec![0; 1024], vec![0; 1024], vec![0.0; 1024]);
        let (o, s) = (g.owner.as_mut_ptr(), g.strength.as_mut_ptr());
        let nc = unsafe {
            (self.api.uct_search)(
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
        let sims = unsafe { (self.api.uct_sims_done)() };
        self.log(format!(
            "search nc={nc} sims={sims} acts={:?} visits={:?} q={:?}",
            &acts[..nc],
            &visits[..nc],
            q[..nc].iter().map(|v: &f64| v.to_bits()).collect::<Vec<_>>()
        ));
    }
}

fn sides() -> [Side; 2] {
    [
        Side {
            api: c_api(),
            trace: vec![],
        },
        Side {
            api: rust_api(),
            trace: vec![],
        },
    ]
}

fn assert_same(sides: &[Side; 2]) {
    let [c, r] = sides;
    for (i, (a, b)) in c.trace.iter().zip(&r.trace).enumerate() {
        assert_eq!(a, b, "trace entry {i} differs");
    }
    assert_eq!(c.trace.len(), r.trace.len());
    eprintln!("{} trace entries matched", c.trace.len());
}

/// Run `script` on both engines with the same test-side randomness, then compare traces.
fn both(seed: u64, mut script: impl FnMut(&mut Side, &mut XorShift)) {
    let mut sides = sides();
    for side in &mut sides {
        script(side, &mut XorShift(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1));
    }
    assert_same(&sides);
}

#[test]
fn board_gen_both_versions() {
    both(1, |side, _| {
        for seed in 0..3000u32 {
            side.new_game(seed.wrapping_mul(2654435761), false);
            side.new_game(seed, true);
        }
    });
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
fn random_play(side: &mut Side, rng: &mut XorShift, g: &mut Game, steps: usize, stepwise_bots: bool) {
    let (mut flips, mut len, mut meta) = (vec![0; 400], 0, vec![0; 5]);
    for step in 0..steps {
        let (o, s) = (g.owner.as_mut_ptr(), g.strength.as_mut_ptr());
        if unsafe { (side.api.ext_check_winner)(o) } >= 0 {
            break;
        }
        let attacks = red_attacks(g);
        let choice = rng.below(attacks.len() + 2);
        if choice < attacks.len() {
            let (from, to) = attacks[choice];
            if step % 2 == 0 {
                unsafe {
                    (side.api.resolve_battle_logged)(
                        o,
                        s,
                        from as c_int,
                        to as c_int,
                        flips.as_mut_ptr(),
                        &mut len,
                        meta.as_mut_ptr(),
                    )
                };
                side.log(format!(
                    "logged {from}->{to} flips={:?} meta={meta:?}",
                    &flips[..len as usize]
                ));
            } else {
                unsafe { (side.api.ext_resolve_battle)(o, s, from as c_int, to as c_int) };
            }
        } else if choice == attacks.len() {
            // An illegal request: rejected with no dice consumed.
            let (from, to) = (rng.below(g.n), rng.below(g.n));
            let legal = unsafe { (side.api.ext_attack_legal)(o, s, from as c_int, to as c_int) };
            unsafe {
                (side.api.resolve_battle_logged)(
                    o,
                    s,
                    from as c_int,
                    to as c_int,
                    flips.as_mut_ptr(),
                    &mut len,
                    meta.as_mut_ptr(),
                )
            };
            side.log(format!("probe {from}->{to} legal={legal} meta={meta:?}"));
        } else if stepwise_bots {
            unsafe { (side.api.ext_reinforce)(o, s, 0) };
            for bot in 1..5 {
                let mut st = vec![0; 67];
                unsafe { (side.api.bot_turn_begin)(o, s, bot, st.as_mut_ptr()) };
                side.log(format!("cursor {bot} {st:?}"));
                if unsafe { (side.api.ext_check_winner)(o) } >= 0 {
                    break;
                }
                loop {
                    let mv = unsafe { (side.api.bot_turn_next)(o, s, bot, st.as_mut_ptr()) };
                    side.log(format!("bot {bot} next={mv} st={:?}", &st[..3]));
                    if mv == 0 {
                        unsafe { (side.api.ext_reinforce)(o, s, bot) };
                        break;
                    }
                    let mv = mv - 1;
                    unsafe { (side.api.ext_resolve_battle)(o, s, mv >> 8, mv & 0xFF) };
                }
            }
        } else {
            unsafe { (side.api.end_turn)(o, s) };
        }
        side.board(g, "step");
        side.log(format!("mb={}", unsafe { (side.api.get_rng_mb32)() }));
    }
}

#[test]
fn random_legal_play() {
    both(2, |side, rng| {
        for seed in 1..=400u32 {
            let legacy = seed % 5 == 0;
            let mut g = side.new_game(seed, legacy);
            random_play(side, rng, &mut g, 300, seed % 3 == 0);
        }
    });
}

#[test]
fn rollouts_and_sweep() {
    both(3, |side, rng| {
        for seed in 1..=150u32 {
            let mut g = side.new_game(seed, false);
            let steps = 20 + rng.below(40);
            random_play(side, rng, &mut g, steps, false);
            let (o, s) = (g.owner.as_mut_ptr(), g.strength.as_mut_ptr());
            unsafe { (side.api.set_sim_seed)(seed as u64 * 7919) };
            unsafe { (side.api.use_sim_rng)() };
            let rolls: Vec<_> = (0..40).map(|_| unsafe { (side.api.rollout)(o, s, 3) }).collect();
            let sweep = unsafe { (side.api.sweep_best_move)(o, s) };
            unsafe { (side.api.use_mb32_rng)() };
            let cert = unsafe { (side.api.sweep_certify)(o, s, 3, 200, 5) };
            let mb = unsafe { (side.api.get_rng_mb32)() };
            side.log(format!("rolls={rolls:?} sweep={sweep} cert={cert} mb={mb}"));
        }
    });
}

/// Stacks past the 160 table and past the 1024 extension.
#[test]
fn large_stacks() {
    both(4, |side, rng| {
        for seed in 1..=60u32 {
            let mut g = side.new_game(seed, false);
            random_play(side, rng, &mut g, 10, false);
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
            unsafe { (side.api.set_sim_seed)(seed as u64) };
            unsafe { (side.api.use_sim_rng)() };
            let (o, s) = (g.owner.as_mut_ptr(), g.strength.as_mut_ptr());
            let rolls: Vec<_> = (0..4).map(|_| unsafe { (side.api.rollout)(o, s, 297) }).collect();
            side.log(format!("rolls={rolls:?}"));
            unsafe { (side.api.uct_set_grade)(0) };
            side.search(&mut g, 298, 64, 64, 1);
        }
    });
}

/// Drop random links so factions split into components, some borderless.
#[test]
fn disconnected_imports() {
    both(5, |side, rng| {
        for seed in 1..=300u32 {
            let g0 = side.new_game(seed, false);
            let mut adj = g0.adj.clone();
            for i in 0..g0.n {
                for j in g0.adj[i].clone() {
                    if i < j && rng.below(3) == 0 {
                        adj[i].retain(|&k| k != j);
                        adj[j].retain(|&k| k != i);
                    }
                }
            }
            side.set_topology(&adj);
            let mut g = Game { adj, ..g0 };
            for f in 0..5 {
                unsafe { (side.api.ext_reinforce)(g.owner.as_mut_ptr(), g.strength.as_mut_ptr(), f) };
                side.board(&g, "reinforce");
            }
            unsafe { (side.api.set_rng_mb32)(seed.wrapping_mul(977)) };
            unsafe { (side.api.use_mb32_rng)() };
            for bot in 1..5 {
                unsafe { (side.api.ext_run_bot_turn)(g.owner.as_mut_ptr(), g.strength.as_mut_ptr(), bot) };
                side.board(&g, "bot turn");
            }
            random_play(side, rng, &mut g, 30, seed % 2 == 0);
        }
    });
}

/// Value stop, deep-think, grading modes, nroll > 1, and chunked vs one-shot.
#[test]
fn search_variants() {
    both(6, |side, rng| {
        for seed in 1..=10u32 {
            let mut g = side.new_game(seed, false);
            let steps = rng.below(15);
            random_play(side, rng, &mut g, steps, false);
            if unsafe { (side.api.ext_check_winner)(g.owner.as_mut_ptr()) } >= 0 {
                continue;
            }
            unsafe { (side.api.set_sim_seed)(0x12345678) };
            unsafe { (side.api.use_sim_rng)() };
            match seed % 4 {
                0 => unsafe { (side.api.uct_set_value_stop)(0.03, 0.97, 0.15, 512) },
                1 => unsafe { (side.api.uct_set_deepthink)(4.0, 600, 0.6) },
                2 => unsafe { (side.api.uct_set_grade)(2) },
                _ => unsafe { (side.api.uct_set_grade)(1) },
            }
            side.search(&mut g, 2, 1500, 6000, 1 + (seed % 2) as c_int);
            // Chunked, reading the root between chunks.
            let (o, s) = (g.owner.as_mut_ptr(), g.strength.as_mut_ptr());
            unsafe { (side.api.uct_begin)(o, s, 2, 1000, 3000, 2.5, 1) };
            let (mut acts, mut visits, mut q) = (vec![0; 1024], vec![0; 1024], vec![0.0; 1024]);
            loop {
                let done = unsafe { (side.api.uct_step)(333) };
                let nc =
                    unsafe { (side.api.uct_report)(acts.as_mut_ptr(), visits.as_mut_ptr(), q.as_mut_ptr()) }
                        as usize;
                side.log(format!(
                    "chunk done={done} acts={:?} visits={:?} q={:?}",
                    &acts[..nc],
                    &visits[..nc],
                    q[..nc].iter().map(|v| v.to_bits()).collect::<Vec<_>>()
                ));
                if done != 0 {
                    break;
                }
            }
            unsafe {
                (side.api.uct_set_value_stop)(-1.0, 2.0, 2.0, 1 << 30);
                (side.api.uct_set_deepthink)(0.0, 1 << 30, 2.0);
                (side.api.uct_set_grade)(0);
            }
        }
    });
}
