//! Win check, the decompiled bot turn, reinforcement, and end of turn.

use crate::{Board, Faction, MAXN, NF, RED, Rng, Topology, WIN_NODES, bits, resolve_battle};

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
    if !topo.on_border(board, node, faction) {
        return None;
    }
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
    pub fn begin(board: &Board, faction: Faction) -> BotCursor {
        // Strongest first, equal strengths in node-id order: sort the unique
        // keys (strength, -id) descending.
        let mut keys = [0u64; MAXN];
        let mut count = 0;
        for i in bits(board.owned(faction)) {
            let s = (board.strength[i] as u32 ^ 1 << 31) as u64; // order-preserving
            keys[count] = s << 8 | (MAXN - 1 - i) as u64;
            count += 1;
        }
        keys[..count].sort_unstable_by(|a, b| b.cmp(a));
        let mut islands = [0u8; MAXN];
        for (dst, &k) in islands.iter_mut().zip(&keys[..count]) {
            *dst = (MAXN - 1 - (k & 0xFF) as usize) as u8;
        }
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
        // A stack below 2 can't attack, so it needs no target search.
        if let Some(cur) = self.chain.take().filter(|&c| board.owner[c] == faction)
            && board.strength[cur] >= 2
            && let Some(tgt) = smallest_adjacent_enemy(topo, board, cur, faction)
            && ok_attack(board, cur, tgt)
        {
            self.chain = Some(tgt);
            return Some((cur, tgt));
        }
        while self.next < self.count {
            let island = self.islands[self.next] as usize;
            self.next += 1;
            if board.strength[island] >= 2
                && let Some(tgt) = smallest_adjacent_enemy(topo, board, island, faction)
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
    let own = board.owned(faction);
    let mut rest = own;
    let (mut border, mut chosen_n, mut budget) = (0u64, 0, 0);
    while rest != 0 {
        let component = topo.flood(rest.trailing_zeros() as usize, rest);
        rest &= !component;
        let size = component.count_ones() as i32;
        budget = budget.max(size);
        if size > chosen_n {
            let edge = bits(component).fold(0, |m, i| m | (topo.on_border(board, i, faction) as u64) << i);
            if edge != 0 {
                border = edge;
                chosen_n = size;
            }
        }
    }
    if border == 0 {
        return;
    }
    // Round-robin over the border in ascending id: the first `budget % bn`
    // nodes get one extra.
    let bn = border.count_ones() as i32;
    let (each, extra) = (budget / bn, budget % bn);
    for (k, i) in bits(border).enumerate() {
        board.strength[i] += each + ((k as i32) < extra) as i32;
    }
}

pub fn run_bot_turn(topo: &Topology, rng: &mut impl Rng, board: &mut Board, faction: Faction) {
    if check_winner(topo, board).is_some() || topo.counts(board)[faction as usize] == 0 {
        return;
    }
    let mut cursor = BotCursor::begin(board, faction);
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
