//! Adjacency in CSR form. Neighbor order matters: bots and the search break
//! ties by it, so it must match the C engine's append order exactly.

use crate::{Board, Faction, MAXN, NF, bits};
use std::ops::Range;

pub const MAX_EDGES: usize = MAXN * 8;

#[derive(Clone, Debug)]
pub struct Topology {
    n: usize,
    off: [u16; MAXN + 1],
    adj: [u8; MAX_EDGES],
    /// `adj` as one bitmask per node, for set questions (order-free).
    mask: [u64; MAXN],
    /// Every link is listed from both ends (always true of generated maps).
    symmetric: bool,
}

impl Default for Topology {
    fn default() -> Self {
        Topology {
            n: 0,
            off: [0; MAXN + 1],
            adj: [0; MAX_EDGES],
            mask: [0; MAXN],
            symmetric: true,
        }
    }
}

impl Topology {
    /// From CSR arrays: `off` has `n + 1` entries, `adj` has `off[n]`.
    pub fn from_csr(n: usize, off: &[i32], adj: &[i32]) -> Topology {
        let mut t = Topology {
            n,
            ..Topology::default()
        };
        for (dst, &src) in t.off.iter_mut().zip(&off[..=n]) {
            *dst = src as u16;
        }
        for (dst, &src) in t.adj.iter_mut().zip(&adj[..off[n] as usize]) {
            *dst = src as u8;
        }
        t.build_masks();
        t
    }

    fn build_masks(&mut self) {
        for i in 0..self.n {
            self.mask[i] = self.neighbors(i).fold(0, |m, j| m | 1 << j);
        }
        self.symmetric = (0..self.n).all(|i| bits(self.mask[i]).all(|j| self.mask[j] & 1 << i != 0));
    }

    #[inline(always)]
    pub fn symmetric(&self) -> bool {
        self.symmetric
    }

    /// From per-node neighbor lists, in order.
    pub fn from_lists<L: AsRef<[usize]>>(lists: &[L]) -> Topology {
        let mut t = Topology {
            n: lists.len(),
            ..Topology::default()
        };
        let mut k = 0;
        for (i, list) in lists.iter().enumerate() {
            t.off[i] = k as u16;
            for &j in list.as_ref() {
                t.adj[k] = j as u8;
                k += 1;
            }
        }
        t.off[lists.len()] = k as u16;
        t.build_masks();
        t
    }

    #[inline(always)]
    pub fn n(&self) -> usize {
        self.n
    }

    #[inline(always)]
    pub fn nodes(&self) -> Range<usize> {
        0..self.n
    }

    #[inline(always)]
    pub fn neighbors(&self, i: usize) -> impl Iterator<Item = usize> + '_ {
        let range = self.off[i] as usize..self.off[i + 1] as usize;
        self.adj[range].iter().map(|&j| j as usize)
    }

    pub fn csr_offsets(&self) -> &[u16] {
        &self.off[..=self.n]
    }

    pub fn csr_neighbors(&self) -> &[u8] {
        &self.adj[..self.off[self.n] as usize]
    }

    /// Undirected links `(a, b)` with `a < b`, in CSR order.
    pub fn links(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.nodes()
            .flat_map(move |i| self.neighbors(i).filter(move |&j| i < j).map(move |j| (i, j)))
    }

    /// The neighbors of `i` as a bitmask.
    #[inline(always)]
    pub fn neighbor_mask(&self, i: usize) -> u64 {
        self.mask[i]
    }

    #[inline]
    pub fn counts(&self, board: &Board) -> [i32; NF] {
        std::array::from_fn(|f| board.owned(f as Faction).count_ones() as i32)
    }

    /// Does any neighbor of `i` belong to someone other than `faction`?
    #[inline(always)]
    pub fn on_border(&self, board: &Board, i: usize, faction: Faction) -> bool {
        self.mask[i] & !board.owned(faction) != 0
    }

    /// The nodes reachable from `start` through `within` (which holds `start`).
    #[inline]
    pub fn flood(&self, start: usize, within: u64) -> u64 {
        let (mut reached, mut frontier) = (1u64 << start, 1u64 << start);
        while frontier != 0 {
            let mut next = 0;
            for i in bits(frontier) {
                next |= self.mask[i];
            }
            frontier = next & within & !reached;
            reached |= frontier;
        }
        reached
    }
}
