//! Checks through the C ABI: rejected attack requests, zero-army defenders,
//! chunked vs one-shot search, the grading budget, and finite root values.

use std::ffi::c_int;

use nw_engine::*;

fn line(n: usize) {
    let mut off = vec![0];
    let mut list = vec![];
    for i in 0..n {
        list.extend(
            [i.checked_sub(1), (i + 1 < n).then_some(i + 1)]
                .into_iter()
                .flatten()
                .map(|j| j as c_int),
        );
        off.push(list.len() as c_int);
    }
    unsafe { set_topology(n as c_int, off.as_ptr(), list.as_ptr()) };
}

/// Illegal requests change nothing and consume no dice.
#[test]
fn rejected_requests() {
    line(5);
    let (mut o, mut s) = ([1, 0, 1, 1, 1], [5, 5, 4, 3, 2]);
    let (old_o, old_s) = (o, s);
    let (mut flips, mut len, mut meta) = ([0; 320], 0, [0; 5]);
    use_mb32_rng();
    set_rng_mb32(19);
    for (from, to) in [(-1, 0), (0, 5), (0, 0), (0, 2), (2, 3), (3, 4)] {
        let (po, ps) = (o.as_mut_ptr(), s.as_mut_ptr());
        unsafe {
            assert_eq!(ext_attack_legal(po, ps, from, to), 0);
            ext_resolve_battle(po, ps, from, to);
            resolve_battle_logged(po, ps, from, to, flips.as_mut_ptr(), &mut len, meta.as_mut_ptr());
        }
        assert!(len == 0 && meta[0] == -1 && get_rng_mb32() == 19);
        assert_eq!((o, s), (old_o, old_s));
    }

    // Simultaneous last casualties leave an owned zero-army defender, which
    // the next legal attack captures without spending any coins.
    line(2);
    let (mut o, mut s) = ([0, 1], [2, 0]);
    unsafe { ext_resolve_battle(o.as_mut_ptr(), s.as_mut_ptr(), 0, 1) };
    assert_eq!((o, s, get_rng_mb32()), ([0, 0], [1, 1], 19));
}

struct Root {
    acts: Vec<c_int>,
    visits: Vec<c_int>,
    q: Vec<f64>,
}

fn search(o: &mut [c_int], s: &mut [c_int], turns: c_int, min: c_int, max: c_int, nroll: c_int) -> Root {
    let (mut acts, mut visits, mut q) = (vec![0; 1024], vec![0; 1024], vec![0.0; 1024]);
    let nc = unsafe {
        uct_search(
            o.as_mut_ptr(),
            s.as_mut_ptr(),
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
    acts.truncate(nc);
    visits.truncate(nc);
    q.truncate(nc);
    Root { acts, visits, q }
}

fn deal(seed: u32) -> ([c_int; 64], [c_int; 64]) {
    let (mut o, mut s, mut x, mut y) = ([0; 64], [0; 64], [0; 64], [0; 64]);
    unsafe {
        new_game(
            seed,
            o.as_mut_ptr(),
            s.as_mut_ptr(),
            x.as_mut_ptr(),
            y.as_mut_ptr(),
        )
    };
    (o, s)
}

#[test]
fn streaming_and_grade() {
    let (mut o, mut s) = deal(42);
    let mb = get_rng_mb32();
    uct_set_grade(0);
    uct_set_value_stop(-1.0, 0.0, 2.0, 1); // force an early stop
    use_sim_rng();
    set_sim_seed(123);
    let one_shot = search(&mut o, &mut s, 1, 256, 2048, 1);
    let done = uct_sims_done();
    assert_eq!(done, 256);
    assert!(uct_step(1000) != 0 && uct_sims_done() == done); // completion is sticky

    set_sim_seed(123);
    unsafe { uct_begin(o.as_mut_ptr(), s.as_mut_ptr(), 1, 256, 2048, 2.5, 1) };
    while uct_step(37) == 0 {}
    let (mut acts, mut visits, mut q) = (vec![0; 1024], vec![0; 1024], vec![0.0; 1024]);
    let nc = unsafe { uct_report(acts.as_mut_ptr(), visits.as_mut_ptr(), q.as_mut_ptr()) } as usize;
    assert_eq!((nc, uct_sims_done()), (one_shot.acts.len(), done));
    assert_eq!(
        (&acts[..nc], &visits[..nc], &q[..nc]),
        (&one_shot.acts[..], &one_shot.visits[..], &one_shot.q[..])
    );

    uct_set_grade(1);
    set_sim_seed(123);
    search(&mut o, &mut s, 1, 256, 2048, 1);
    assert_eq!(uct_sims_done(), 2048); // a high leader must not truncate grading
    assert_eq!(get_rng_mb32(), mb);
    uct_set_grade(0);
    uct_set_value_stop(-1.0, 2.0, 2.0, 1 << 30);

    // Zero rollouts is normalized instead of generating NaN.
    let root = search(&mut o, &mut s, 1, 16, 16, 0);
    assert!(root.q.iter().all(|q| q.is_finite() && (0.0..=1.0).contains(q)));
    // A finished game has no root moves.
    o[..30].fill(0);
    assert!(search(&mut o, &mut s, 1, 16, 16, 1).acts.is_empty());
}

#[test]
fn sampled_legality() {
    for seed in 1..=40 {
        let (mut o, mut s) = deal(seed);
        for turn in 1..=3 {
            if unsafe { ext_check_winner(o.as_ptr()) } >= 0 {
                break;
            }
            use_sim_rng();
            set_sim_seed(123);
            let root = search(&mut o, &mut s, turn, 1500, 1500, 1);
            assert!(root.q.iter().all(|q| q.is_finite() && (0.0..=1.0).contains(q)));
            unsafe { end_turn(o.as_mut_ptr(), s.as_mut_ptr()) };
        }
    }
}
