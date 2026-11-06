//! The two dice streams. Both return a double in [0, 1).

pub trait Rng {
    fn next_f64(&mut self) -> f64;

    /// The game's atomic random op: a fair coin (`teamRandom.Next(2)`).
    #[inline(always)]
    fn coin(&mut self) -> bool {
        self.next_f64() < 0.5
    }
}

/// mulberry32: the real seeded game stream (board-gen and the real game's dice).
#[derive(Clone, Copy, Debug)]
pub struct Mulberry32(pub u32);

impl Mulberry32 {
    #[inline(always)]
    fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6D2B79F5);
        let s = self.0;
        let mut t = (s ^ (s >> 15)).wrapping_mul(s | 1);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61)) ^ t;
        t ^ (t >> 14)
    }
}

impl Rng for Mulberry32 {
    #[inline(always)]
    fn next_f64(&mut self) -> f64 {
        self.next_u32() as f64 / 4294967296.0
    }

    /// `x / 2^32 < 0.5` exactly when the top bit is clear.
    #[inline(always)]
    fn coin(&mut self) -> bool {
        self.next_u32() >> 31 == 0
    }
}

/// splitmix64: the private, seed-free stream for search rollouts, so the search
/// never sees the real game's dice.
#[derive(Clone, Copy, Debug)]
pub struct SplitMix64(pub u64);

impl SplitMix64 {
    /// The output before its final `z ^= z >> 31`, which leaves the top bit alone.
    #[inline(always)]
    fn mix(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB)
    }
}

impl Rng for SplitMix64 {
    #[inline(always)]
    fn next_f64(&mut self) -> f64 {
        let z = self.mix();
        ((z ^ (z >> 31)) >> 11) as f64 * (1.0 / 9007199254740992.0) // 53 bits
    }

    /// `(z >> 11) / 2^53 < 0.5` exactly when the top bit is clear.
    #[inline(always)]
    fn coin(&mut self) -> bool {
        self.mix() >> 63 == 0
    }
}
