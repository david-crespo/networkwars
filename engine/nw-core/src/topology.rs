//! Adjacency in CSR form. Neighbor order matters: bots and the search break
//! ties by it, so it must match the C engine's append order exactly.

use crate::{Board, Faction, MAXN, NF};
use std::ops::Range;

pub const MAX_EDGES: usize = MAXN * 8;

#[derive(Clone, Debug)]
pub struct Topology {
    n: usize,
    off: [u16; MAXN + 1],
    adj: [u8; MAX_EDGES],
}

impl Default for Topology {
    fn default() -> Self {
        Topology {
            n: 0,
            off: [0; MAXN + 1],
            adj: [0; MAX_EDGES],
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
        t
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

    #[inline]
    pub fn counts(&self, board: &Board) -> [i32; NF] {
        let mut c = [0; NF];
        for &f in &board.owner[..self.n] {
            c[f as usize] += 1;
        }
        c
    }

    /// Does any neighbor of `i` belong to someone other than `faction`?
    #[inline]
    pub fn on_border(&self, board: &Board, i: usize, faction: Faction) -> bool {
        self.neighbors(i).any(|j| board.owner[j] != faction)
    }
}
