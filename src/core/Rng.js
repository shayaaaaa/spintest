// Seeded PRNG (mulberry32) so combat rolls / AI decisions are repeatable
// for debugging, without pulling in a dependency.
export class Rng {
  constructor(seed = 0xC0FFEE) {
    this.state = seed >>> 0;
  }

  // Returns a float in [0, 1)
  next() {
    let t = (this.state += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + this.next() * (max - min);
  }

  int(min, maxInclusive) {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  pick(array) {
    return array[this.int(0, array.length - 1)];
  }
}
