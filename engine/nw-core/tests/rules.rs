//! Focused gameplay checks: the deal, reinforcement, bot attacks, terminal
//! states and the turn horizon. Source evidence and intentional
//! approximations: solver/RULES_AUDIT.md.

use nw_core::*;

/// Every coin hits.
struct Hits;
impl Rng for Hits {
    fn next_f64(&mut self) -> f64 {
        0.0
    }
}

fn topology(n: usize, edges: &[(usize, usize)]) -> Topology {
    let mut lists = vec![vec![]; n];
    for i in 0..n {
        for &(a, b) in edges {
            if a == i {
                lists[i].push(b);
            }
            if b == i {
                lists[i].push(a);
            }
        }
    }
    Topology::from_lists(&lists)
}

fn linked(topo: &Topology, a: usize, b: usize) -> bool {
    topo.neighbors(a).any(|j| j == b)
}

fn triple(topo: &Topology, a: usize, b: usize, c: usize) -> bool {
    linked(topo, a, b) as u8 + linked(topo, a, c) as u8 + linked(topo, b, c) as u8 >= 2
}

/// The deal: six nodes and twenty armies per faction, with the large armies
/// grouped as the recovered splitArmies places them.
#[test]
fn openings() {
    let mut observed = [0; 6];
    for seed in 0..10000 {
        let game = generate(&mut Mulberry32(seed), RulesVersion::Current);
        let (topo, board) = (&game.topology, &game.board);
        assert_eq!(topo.n(), 30);
        for f in 0..NF as Faction {
            let nodes: Vec<usize> = bits(board.owned(f)).collect();
            let big: Vec<usize> = nodes.iter().copied().filter(|&i| board.strength[i] > 1).collect();
            let total: i32 = nodes.iter().map(|&i| board.strength[i]).sum();
            assert!(nodes.len() == 6 && total == 20 && (2..=5).contains(&big.len()));
            observed[big.len()] += 1;
            let s = |i: usize| board.strength[big[i]];
            match big.len() {
                3 => assert!(triple(topo, big[0], big[1], big[2])),
                // splitArmies(4, 18) groups [5,5] and [4,4].
                4 => assert!(
                    (0..4).all(|i| (0..4).any(|j| i != j && s(i) == s(j) && linked(topo, big[i], big[j])))
                ),
                // A connected [4,4,4] triple plus an adjacent [4,3] pair.
                5 => assert!((0..5).any(|i| (i + 1..5).any(|j| {
                    let rest: Vec<usize> = (0..5).filter(|&k| k != i && k != j).map(|k| big[k]).collect();
                    s(i) + s(j) == 7
                        && linked(topo, big[i], big[j])
                        && triple(topo, rest[0], rest[1], rest[2])
                }))),
                _ => {}
            }
        }
    }
    assert!(observed[2..].iter().all(|&n| n > 0));
}

#[test]
fn reinforcement() {
    let topo = topology(7, &[(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6)]);
    let mut b = Board::from_slices(&[0, 0, 0, 0, 1, 0, 1], &[1; 7]);
    reinforce(&topo, &mut b, 0);
    assert_eq!(b.strength[..7], [1, 1, 1, 5, 1, 1, 1]);

    // A disconnected, borderless largest component still supplies a budget
    // of three to the smaller component's sole border node.
    let topo = topology(6, &[(0, 1), (1, 2), (3, 4), (4, 5)]);
    let mut b = Board::from_slices(&[0, 0, 0, 0, 0, 1], &[1; 6]);
    reinforce(&topo, &mut b, 0);
    assert_eq!(b.strength[..6], [1, 1, 1, 1, 4, 1]);
    reinforce(&topo, &mut b, 4); // eliminated faction
    assert_eq!(b.strength[4], 4);

    let topo = topology(5, &[(0, 1), (1, 2), (2, 3), (3, 4)]);
    let mut b = Board::from_slices(&[1, 0, 0, 0, 1], &[1; 5]);
    reinforce(&topo, &mut b, 0);
    assert_eq!(b.strength[1..4], [3, 1, 2]); // three split 2+1
}

#[test]
fn bots_chain_and_need_a_weaker_target() {
    let topo = topology(5, &[(0, 1), (1, 2), (2, 3), (3, 4)]);
    let mut b = Board::from_slices(&[1, 0, 0, 0, 2], &[6, 1, 1, 1, 1]);
    let mut cursor = BotCursor::begin(&b, 1);
    for from in 0..4 {
        assert_eq!(cursor.next_attack(&topo, &b), Some((from, from + 1)));
        resolve_battle(&mut Hits, &mut b, from, from + 1);
        assert!(b.strength[from] == 1 && b.owner[from + 1] == 1 && b.strength[from + 1] == 5 - from as i32);
    }
    assert_eq!(cursor.next_attack(&topo, &b), None);

    // Bots require a strictly weaker enemy; humans may attack equal or larger.
    let b = Board::from_slices(&[1, 0, 1, 1, 1], &[5, 5, 4, 3, 2]);
    assert_eq!(BotCursor::begin(&b, 1).next_attack(&topo, &b), None);
    assert!(attack_legal(&topo, &b, 1, 0));
}

#[test]
fn terminal_states() {
    let topo = topology(30, &[(0, 24)]);
    let owner: Vec<i32> = (0..30).map(|i| (i >= 24) as i32).collect();
    let mut b = Board::from_slices(&owner, &[2; 30]);
    assert_eq!(check_winner(&topo, &b), Some(RED));
    let before = b;
    end_turn(&topo, &mut Hits, &mut b);
    assert_eq!(b, before);
    b.set_owner(23, 1);
    assert_eq!(check_winner(&topo, &b), None);
}

/// A stalemate where RED only holds a plurality loses at the horizon, in
/// rollouts and in the sweep certificate.
#[test]
fn horizon_plurality_is_a_loss() {
    let topo = topology(30, &[]);
    let owner: Vec<i32> = (0..30).map(|i| (i >= 18) as i32).collect();
    let b = Board::from_slices(&owner, &[1; 30]);
    let mut rng = SplitMix64(1);
    assert!(!rollout(&topo, &mut CapTables::new(), &mut rng, &b, MAX_TURNS));
    assert!(sweep_certify(&topo, &mut rng, &b, MAX_TURNS, 10, 0) > 0);
}
