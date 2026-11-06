//! The C ABI of `solver/fast_engine.c`, exactly: same names, same signatures,
//! one engine per process (or per WASM instance). Clients (`fastnw.py`,
//! `src/fastnw.js`) load this in place of the C build unchanged.
//!
//! Every function copies the caller's `owner`/`strength` arrays (length N of
//! the current topology) in, runs the core, and copies results back.
#![allow(clippy::missing_safety_doc)]

use nw_core::{
    Action, Board, BotCursor, Engine, MAXN, RngChoice, RulesVersion, Topology, attack_legal, check_winner,
    reinforce, with_rng,
};
use std::ffi::{c_double, c_int};
use std::slice;
use std::sync::Mutex;

static ENGINE: Mutex<Option<Box<Engine>>> = Mutex::new(None);

fn with_engine<T>(f: impl FnOnce(&mut Engine) -> T) -> T {
    let mut guard = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(|| Box::new(Engine::new())))
}

unsafe fn read_board(e: &Engine, owner: *const c_int, strength: *const c_int) -> Board {
    let n = e.topo.n();
    unsafe {
        Board::from_slices(
            slice::from_raw_parts(owner, n),
            slice::from_raw_parts(strength, n),
        )
    }
}

unsafe fn read_owner(e: &Engine, owner: *const c_int) -> Board {
    let n = e.topo.n();
    unsafe { Board::from_slices(slice::from_raw_parts(owner, n), &[]) }
}

unsafe fn write_board(e: &Engine, board: &Board, owner: *mut c_int, strength: *mut c_int) {
    let n = e.topo.n();
    unsafe {
        board.write_to(
            slice::from_raw_parts_mut(owner, n),
            slice::from_raw_parts_mut(strength, n),
        );
    }
}

/// Run `f` on a copy of the caller's board and write the result back.
unsafe fn mutate(owner: *mut c_int, strength: *mut c_int, f: impl FnOnce(&mut Engine, &mut Board)) {
    with_engine(|e| unsafe {
        let mut board = read_board(e, owner, strength);
        f(e, &mut board);
        write_board(e, &board, owner, strength);
    })
}

const BOT_STATE_LEN: usize = MAXN + 3;

/// The bot cursor lives in the caller's int buffer: `[count, next, chain
/// (-1 = none), islands...]`.
unsafe fn read_cursor(st: *const c_int, faction: c_int) -> BotCursor {
    let st = unsafe { slice::from_raw_parts(st, BOT_STATE_LEN) };
    let count = st[0] as usize;
    let mut islands = [0u8; MAXN];
    for (dst, &src) in islands.iter_mut().zip(&st[3..3 + count]) {
        *dst = src as u8;
    }
    BotCursor {
        faction: faction as u8,
        islands,
        count,
        next: st[1] as usize,
        chain: (st[2] >= 0).then_some(st[2] as usize),
    }
}

// ---- topology ----

#[unsafe(no_mangle)]
pub unsafe extern "C" fn set_topology(n: c_int, adj_off: *const c_int, adj_list: *const c_int) {
    let n = n as usize;
    let off = unsafe { slice::from_raw_parts(adj_off, n + 1) };
    let adj = unsafe { slice::from_raw_parts(adj_list, off[n] as usize) };
    with_engine(|e| e.topo = Topology::from_csr(n, off, adj));
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn get_adj(out_off: *mut c_int, out_list: *mut c_int) -> c_int {
    with_engine(|e| unsafe {
        let off = e.topo.csr_offsets();
        let adj = e.topo.csr_neighbors();
        for (i, &o) in off.iter().enumerate() {
            *out_off.add(i) = o as c_int;
        }
        for (i, &j) in adj.iter().enumerate() {
            *out_list.add(i) = j as c_int;
        }
        e.topo.n() as c_int
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn get_links(out: *mut c_int) -> c_int {
    with_engine(|e| unsafe {
        let mut count = 0;
        for (a, b) in e.topo.links() {
            *out.add(2 * count) = a as c_int;
            *out.add(2 * count + 1) = b as c_int;
            count += 1;
        }
        count as c_int
    })
}

// ---- rng ----

#[unsafe(no_mangle)]
pub extern "C" fn set_rng_mb32(seed: u32) {
    with_engine(|e| e.game_rng.0 = seed);
}

#[unsafe(no_mangle)]
pub extern "C" fn get_rng_mb32() -> u32 {
    with_engine(|e| e.game_rng.0)
}

#[unsafe(no_mangle)]
pub extern "C" fn set_sim_seed(seed: u64) {
    with_engine(|e| e.sim_rng.0 = seed);
}

#[unsafe(no_mangle)]
pub extern "C" fn use_mb32_rng() {
    with_engine(|e| e.active = RngChoice::Game);
}

#[unsafe(no_mangle)]
pub extern "C" fn use_sim_rng() {
    with_engine(|e| e.active = RngChoice::Sim);
}

// ---- board generation ----

unsafe fn new_game_version(
    seed: u32,
    rules: RulesVersion,
    owner: *mut c_int,
    strength: *mut c_int,
    x: *mut c_int,
    y: *mut c_int,
) -> c_int {
    with_engine(|e| unsafe {
        let game = e.new_game(seed, rules);
        let n = e.topo.n();
        write_board(e, &game.board, owner, strength);
        slice::from_raw_parts_mut(x, n).copy_from_slice(&game.x[..n]);
        slice::from_raw_parts_mut(y, n).copy_from_slice(&game.y[..n]);
        n as c_int
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn new_game(
    seed: u32,
    owner: *mut c_int,
    strength: *mut c_int,
    x: *mut c_int,
    y: *mut c_int,
) -> c_int {
    unsafe { new_game_version(seed, RulesVersion::Current, owner, strength, x, y) }
}

/// Rules version 1, only to reproduce saved games.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn new_game_legacy(
    seed: u32,
    owner: *mut c_int,
    strength: *mut c_int,
    x: *mut c_int,
    y: *mut c_int,
) -> c_int {
    unsafe { new_game_version(seed, RulesVersion::Legacy, owner, strength, x, y) }
}

// ---- rules ----

fn legal(e: &Engine, board: &Board, frm: c_int, to: c_int) -> bool {
    frm >= 0 && to >= 0 && attack_legal(&e.topo, board, frm as usize, to as usize)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ext_attack_legal(
    owner: *const c_int,
    strength: *const c_int,
    frm: c_int,
    to: c_int,
) -> c_int {
    with_engine(|e| {
        let board = unsafe { read_board(e, owner, strength) };
        legal(e, &board, frm, to) as c_int
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ext_resolve_battle(owner: *mut c_int, strength: *mut c_int, frm: c_int, to: c_int) {
    unsafe {
        mutate(owner, strength, |e, board| {
            if legal(e, board, frm, to) {
                e.resolve_battle(board, frm as usize, to as usize);
            }
        })
    }
}

/// `out_meta` = `{captured, fromStart, toStart, fromStrength, toStrength}`,
/// or `captured = -1` for a rejected attack (board and dice untouched).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn resolve_battle_logged(
    owner: *mut c_int,
    strength: *mut c_int,
    frm: c_int,
    to: c_int,
    out_flips: *mut c_int,
    out_len: *mut c_int,
    out_meta: *mut c_int,
) {
    unsafe {
        let meta = slice::from_raw_parts_mut(out_meta, 5);
        mutate(owner, strength, |e, board| {
            if !legal(e, board, frm, to) {
                *out_len = 0;
                meta.copy_from_slice(&[-1, 0, 0, 0, 0]);
                return;
            }
            let (from, to) = (frm as usize, to as usize);
            let flips = slice::from_raw_parts_mut(out_flips, nw_core::BATTLE_LOG_CAP);
            let (outcome, len) = with_rng!(e, |rng| nw_core::resolve_battle_logged(
                rng, board, from, to, flips
            ));
            *out_len = len as c_int;
            meta.copy_from_slice(&[
                outcome.captured as c_int,
                outcome.from_start,
                outcome.to_start,
                board.strength[from],
                board.strength[to],
            ]);
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ext_reinforce(owner: *mut c_int, strength: *mut c_int, faction: c_int) {
    unsafe {
        mutate(owner, strength, |e, board| {
            reinforce(&e.topo, board, faction as u8)
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ext_run_bot_turn(owner: *mut c_int, strength: *mut c_int, faction: c_int) {
    unsafe { mutate(owner, strength, |e, board| e.run_bot_turn(board, faction as u8)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn end_turn(owner: *mut c_int, strength: *mut c_int) {
    unsafe { mutate(owner, strength, |e, board| e.end_turn(board)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ext_check_winner(owner: *const c_int) -> c_int {
    with_engine(|e| {
        let board = unsafe { read_owner(e, owner) };
        check_winner(&e.topo, &board).map_or(-1, |w| w as c_int)
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bot_turn_begin(
    owner: *const c_int,
    strength: *const c_int,
    faction: c_int,
    st: *mut c_int,
) {
    with_engine(|e| unsafe {
        let board = read_board(e, owner, strength);
        let cursor = BotCursor::begin(&board, faction as u8);
        let st = slice::from_raw_parts_mut(st, BOT_STATE_LEN);
        st[0] = cursor.count as c_int;
        st[1] = 0;
        st[2] = -1;
        for (dst, &i) in st[3..].iter_mut().zip(&cursor.islands[..cursor.count]) {
            *dst = i as c_int;
        }
    })
}

/// The next attack as `(frm << 8 | to) + 1`, or 0 when the turn's attacks are done.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bot_turn_next(
    owner: *const c_int,
    strength: *const c_int,
    faction: c_int,
    st: *mut c_int,
) -> c_int {
    with_engine(|e| unsafe {
        let board = read_board(e, owner, strength);
        let mut cursor = read_cursor(st, faction);
        let next = cursor.next_attack(&e.topo, &board);
        *st.add(1) = cursor.next as c_int;
        *st.add(2) = cursor.chain.map_or(-1, |c| c as c_int);
        next.map_or(0, |(from, to)| Action::attack(from, to).0 + 1)
    })
}

// ---- sweep-up ----

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sweep_best_move(owner: *const c_int, strength: *const c_int) -> c_int {
    with_engine(|e| {
        let board = unsafe { read_board(e, owner, strength) };
        nw_core::sweep_best_move(&e.topo, &board).0
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sweep_certify(
    owner: *const c_int,
    strength: *const c_int,
    turns: c_int,
    trials: c_int,
    max_losses: c_int,
) -> c_int {
    with_engine(|e| {
        let board = unsafe { read_board(e, owner, strength) };
        e.sweep_certify(&board, turns, trials, max_losses)
    })
}

// ---- rollout + search ----

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rollout(owner: *const c_int, strength: *const c_int, turns: c_int) -> c_int {
    with_engine(|e| {
        let board = unsafe { read_board(e, owner, strength) };
        e.rollout(&board, turns) as c_int
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn uct_set_grade(mode: c_int) {
    with_engine(|e| e.search.grade = mode);
}

#[unsafe(no_mangle)]
pub extern "C" fn uct_set_value_stop(lo: c_double, hi: c_double, gap: c_double, min_vis: c_int) {
    with_engine(|e| e.search.value_stop = nw_core::ValueStop { lo, hi, gap, min_vis });
}

#[unsafe(no_mangle)]
pub extern "C" fn uct_set_deepthink(ratio: c_double, min_vis: c_int, behind: c_double) {
    with_engine(|e| {
        e.search.deep_think = nw_core::DeepThink {
            ratio,
            min_vis,
            behind,
        }
    });
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn uct_begin(
    owner: *const c_int,
    strength: *const c_int,
    root_turns: c_int,
    min_sims: c_int,
    max_sims: c_int,
    c_puct: c_double,
    nroll: c_int,
) -> c_int {
    with_engine(|e| {
        let board = unsafe { read_board(e, owner, strength) };
        match e
            .search
            .begin(&e.topo, &board, root_turns, min_sims, max_sims, c_puct, nroll)
        {
            Ok(()) => 0,
            Err(_) => -1,
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn uct_step(budget: c_int) -> c_int {
    with_engine(|e| e.search_step(budget) as c_int)
}

unsafe fn report(e: &Engine, out_acts: *mut c_int, out_visits: *mut c_int, out_q: *mut c_double) -> c_int {
    let mut count = 0;
    for (k, child) in e.search.report().enumerate() {
        unsafe {
            *out_acts.add(k) = child.action.0;
            *out_visits.add(k) = child.visits;
            if !out_q.is_null() {
                *out_q.add(k) = child.q;
            }
        }
        count += 1;
    }
    count
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn uct_report(
    out_acts: *mut c_int,
    out_visits: *mut c_int,
    out_q: *mut c_double,
) -> c_int {
    with_engine(|e| unsafe { report(e, out_acts, out_visits, out_q) })
}

#[unsafe(no_mangle)]
pub extern "C" fn uct_sims_done() -> c_int {
    with_engine(|e| e.search.sims_done())
}

/// Run a whole search (the streaming path to completion). Returns the root
/// child count, or -1 if the pools cannot be allocated.
#[allow(clippy::too_many_arguments)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn uct_search(
    owner: *const c_int,
    strength: *const c_int,
    root_turns: c_int,
    min_sims: c_int,
    max_sims: c_int,
    c_puct: c_double,
    nroll: c_int,
    out_acts: *mut c_int,
    out_visits: *mut c_int,
    out_q: *mut c_double,
) -> c_int {
    with_engine(|e| unsafe {
        let board = read_board(e, owner, strength);
        if e.search
            .begin(&e.topo, &board, root_turns, min_sims, max_sims, c_puct, nroll)
            .is_err()
        {
            return -1;
        }
        while !e.search_step(i32::MAX) {}
        report(e, out_acts, out_visits, out_q)
    })
}

// ---- WASM heap for JS clients (emscripten's `_malloc`/`_free`) ----

#[cfg(target_arch = "wasm32")]
mod heap {
    use std::alloc::{Layout, alloc, dealloc};

    const HEADER: usize = 8;

    #[unsafe(no_mangle)]
    pub extern "C" fn nw_malloc(size: usize) -> *mut u8 {
        let layout = Layout::from_size_align(size + HEADER, 8).unwrap();
        unsafe {
            let p = alloc(layout);
            if p.is_null() {
                return p;
            }
            (p as *mut usize).write(size);
            p.add(HEADER)
        }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn nw_free(p: *mut u8) {
        if p.is_null() {
            return;
        }
        unsafe {
            let base = p.sub(HEADER);
            let size = (base as *const usize).read();
            dealloc(base, Layout::from_size_align(size + HEADER, 8).unwrap());
        }
    }
}
