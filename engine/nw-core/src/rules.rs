//! Win check, the decompiled bot turn, reinforcement, and end of turn.

use crate::{Board, Faction, MAXN, NF, RED, Rng, Topology, WIN_NODES, resolve_battle};

/// A faction at 24 nodes wins, as does the last faction standing.
#[inline]
pub fn winner_from_counts(c: &[i32; NF]) -> Option<Faction> {
    if let Some(f) = c.iter().position(|&n| n >= WIN_NODES) {
        return Some(f as Faction);
    }
    let mut alive = c.iter().enumerate().filter(|&(_, &n)| n > 0);
    match (alive.next(), alive.next()) {
        (Some((f, _)), None) => Some(f as Faction),
        _ => None,
    }
}

#[inline]
pub fn check_winner(topo: &Topology, board: &Board) -> Option<Faction> {
    winner_from_counts(&topo.counts(board))
}

/// A legal attack: adjacent, different owners, attacker has at least 2, and
/// the game is not over. Rejected requests must consume no dice.
pub fn attack_legal(topo: &Topology, board: &Board, from: usize, to: usize) -> bool {
    from < topo.n()
        && to < topo.n()
        && from != to
        && board.owner[from] != board.owner[to]
        && board.strength[from] >= 2
        && check_winner(topo, board).is_none()
        && topo.neighbors(from).any(|j| j == to)
}

/// Smallest adjacent enemy of `node` (first found wins ties).
fn smallest_adjacent_enemy(topo: &Topology, board: &Board, node: usize, faction: Faction) -> Option<usize> {
    let mut best: Option<usize> = None;
    for j in topo.neighbors(node) {
        if board.owner[j] == faction {
            continue;
        }
        if best.is_none_or(|b| board.strength[j] < board.strength[b]) {
            best = Some(j);
        }
    }
    best
}

/// okAttack: the attacker has at least 2 and strictly more than the defender.
#[inline]
fn ok_attack(board: &Board, from: usize, to: usize) -> bool {
    board.strength[from] >= 2 && board.strength[from] > board.strength[to]
}

/// A bot's turn in progress, decompiled from `OpponentAIOriginal`: one pass over
/// the islands owned at turn start, strongest first (ties by node id). Each
/// island attacks its smallest adjacent enemy; on capture the moved stack keeps
/// attacking (the chain) until a repel or okAttack fails. No RNG in move choice.
#[derive(Clone, Debug)]
pub struct BotCursor {
    pub faction: Faction,
    pub islands: [u8; MAXN],
    pub count: usize,
    /// Next island to open a chain from.
    pub next: usize,
    /// Target of the last attack: if we now own it, the chain continues there.
    pub chain: Option<usize>,
}

impl BotCursor {
    pub fn begin(topo: &Topology, board: &Board, faction: Faction) -> BotCursor {
        let mut islands = [0u8; MAXN];
        let mut count = 0;
        for i in topo.nodes().filter(|&i| board.owner[i] == faction) {
            islands[count] = i as u8;
            count += 1;
        }
        // Stable, so equal strengths stay in node-id order.
        islands[..count].sort_by_key(|&i| std::cmp::Reverse(board.strength[i as usize]));
        BotCursor {
            faction,
            islands,
            count,
            next: 0,
            chain: None,
        }
    }

    /// The next attack `(from, to)`, or `None` when the turn's attacks are done.
    /// Call it with the previous attack already resolved.
    pub fn next_attack(&mut self, topo: &Topology, board: &Board) -> Option<(usize, usize)> {
        let faction = self.faction;
        // After a capture the chain continues from the stack that moved.
        if let Some(cur) = self.chain.take().filter(|&c| board.owner[c] == faction)
            && let Some(tgt) = smallest_adjacent_enemy(topo, board, cur, faction)
            && ok_attack(board, cur, tgt)
        {
            self.chain = Some(tgt);
            return Some((cur, tgt));
        }
        while self.next < self.count {
            let island = self.islands[self.next] as usize;
            self.next += 1;
            if let Some(tgt) = smallest_adjacent_enemy(topo, board, island, faction)
                && ok_attack(board, island, tgt)
            {
                self.chain = Some(tgt);
                return Some((island, tgt));
            }
        }
        None
    }
}

/// Reinforce `faction`: the budget is its largest component's size, spent
/// round-robin over the border (ascending id) of the largest component that
/// has one. Ties keep the lower start id. On disconnected imports the budget
/// of a borderless largest component carries over (Utils.reinforce).
pub fn reinforce(topo: &Topology, board: &mut Board, faction: Faction) {
    let mut seen = 0u64;
    let mut chosen = 0u64;
    let (mut chosen_n, mut budget) = (0, 0);
    let mut stack = [0u8; MAXN];
    for s in topo.nodes() {
        if board.owner[s] != faction || seen & (1 << s) != 0 {
            continue;
        }
        let (mut top, mut members, mut size, mut has_border) = (0, 0u64, 0, false);
        stack[top] = s as u8;
        top += 1;
        seen |= 1 << s;
        while top > 0 {
            top -= 1;
            let node = stack[top] as usize;
            members |= 1 << node;
            size += 1;
            for j in topo.neighbors(node) {
                if board.owner[j] != faction {
                    has_border = true;
                } else if seen & (1 << j) == 0 {
                    seen |= 1 << j;
                    stack[top] = j as u8;
                    top += 1;
                }
            }
        }
        budget = budget.max(size);
        if has_border && size > chosen_n {
            chosen = members;
            chosen_n = size;
        }
    }
    if chosen_n == 0 {
        return;
    }
    let mut border = [0u8; MAXN];
    let mut bn = 0;
    for i in topo.nodes() {
        if chosen & (1 << i) != 0 && topo.on_border(board, i, faction) {
            border[bn] = i as u8;
            bn += 1;
        }
    }
    for k in 0..budget {
        board.strength[border[k % bn] as usize] += 1;
    }
}

pub fn run_bot_turn(topo: &Topology, rng: &mut impl Rng, board: &mut Board, faction: Faction) {
    if check_winner(topo, board).is_some() || topo.counts(board)[faction as usize] == 0 {
        return;
    }
    let mut cursor = BotCursor::begin(topo, board, faction);
    while let Some((from, to)) = cursor.next_attack(topo, board) {
        resolve_battle(rng, board, from, to);
        // Only a capture can change the winner.
        if board.owner[to] == faction && check_winner(topo, board).is_some() {
            return;
        }
    }
    reinforce(topo, board, faction);
}

/// RED ends its turn: RED reinforces, then each bot takes its turn.
pub fn end_turn(topo: &Topology, rng: &mut impl Rng, board: &mut Board) {
    if check_winner(topo, board).is_some() {
        return;
    }
    reinforce(topo, board, RED);
    if check_winner(topo, board).is_some() {
        return;
    }
    for bot in 1..NF as Faction {
        run_bot_turn(topo, rng, board, bot);
        if check_winner(topo, board).is_some() {
            return;
        }
    }
}
