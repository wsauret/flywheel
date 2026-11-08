import { createHash } from "node:crypto";

/** CPython's `random.Random`: the Mersenne Twister MT19937 with CPython's
 *  seeding, so that a seed gives the same draws as the board's Python code.
 *  The harness leaderboard seeds its paired bootstrap with a string, and only
 *  the same generator reproduces its intervals. */
export class PythonRandom {
  private readonly state = new Uint32Array(624);
  private index = 624;

  /** Seeds like `random.Random(seed)`: an integer by its 32-bit words, least
   *  significant first; a string by its UTF-8 bytes followed by their SHA-512
   *  digest, read as one big-endian integer. */
  constructor(seed: string | number) {
    this.seedByArray(seedWords(seed));
  }

  /** `random.random()`: a double in [0, 1) from 53 random bits. */
  random(): number {
    const high = this.next() >>> 5;
    const low = this.next() >>> 6;
    return (high * 67108864 + low) / 9007199254740992;
  }

  /** `random.choices(range(n), k=k)`: k positions in [0, n), with replacement. */
  choices(n: number, k: number): number[] {
    return Array.from({ length: k }, () => Math.floor(this.random() * n));
  }

  private seedByArray(key: readonly number[]): void {
    const mt = this.state;
    mt[0] = 19650218;
    for (let i = 1; i < 624; i++) mt[i] = (Math.imul(1812433253, mt[i - 1]! ^ (mt[i - 1]! >>> 30)) + i) >>> 0;
    let i = 1;
    let j = 0;
    for (let k = Math.max(624, key.length); k > 0; k--) {
      mt[i] = ((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= 624) { mt[0] = mt[623]!; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k > 0; k--) {
      mt[i] = ((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { mt[0] = mt[623]!; i = 1; }
    }
    mt[0] = 0x80000000;
    this.index = 624;
  }

  private next(): number {
    const mt = this.state;
    if (this.index >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k]! & 0x80000000) | (mt[(k + 1) % 624]! & 0x7fffffff);
        mt[k] = (mt[(k + 397) % 624]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
      }
      this.index = 0;
    }
    let y = mt[this.index++]!;
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    return (y ^ (y >>> 18)) >>> 0;
  }
}

function seedWords(seed: string | number): number[] {
  let value: bigint;
  if (typeof seed === "number") {
    if (!Number.isSafeInteger(seed)) throw new Error("an integer seed must be a safe integer");
    value = BigInt(Math.abs(seed));
  } else {
    const bytes = Buffer.from(seed, "utf8");
    value = BigInt(`0x${Buffer.concat([bytes, createHash("sha512").update(bytes).digest()]).toString("hex")}`);
  }
  const words: number[] = [];
  while (value > 0n) {
    words.push(Number(value & 0xffffffffn));
    value >>= 32n;
  }
  return words.length === 0 ? [0] : words;
}

/** CPython 3.12+ `sum()` over floats: Neumaier compensated summation, so that
 *  a port adds a list of floats to the same double as the board does. */
export function pythonSum(values: Iterable<number>): number {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    const sum = total + value;
    compensation += Math.abs(total) >= Math.abs(value) ? (total - sum) + value : (value - sum) + total;
    total = sum;
  }
  return compensation !== 0 && Number.isFinite(compensation) ? total + compensation : total;
}

/** CPython `round(x, digits)`: the exact binary value rounded to `digits`
 *  decimals, an exact tie going to the even digit. */
export function pythonRound(value: number, digits: number): number {
  const exact = Math.abs(value).toFixed(100);
  const point = exact.indexOf(".");
  const tail = exact.slice(point + 1 + digits);
  const tie = tail[0] === "5" && /^5?0*$/.test(tail);
  if (!tie) return Number(value.toFixed(digits));
  const truncated = exact.slice(0, point + 1 + digits);
  const lastDigit = Number(truncated[truncated.length - 1] === "." ? truncated[truncated.length - 2] : truncated[truncated.length - 1]);
  const magnitude = lastDigit % 2 === 0 ? Number(truncated) : Number((Number(truncated) + 10 ** -digits).toFixed(digits));
  return Math.sign(value) * magnitude;
}

/** `statistics.quantiles(values, n=n, method="inclusive")`: the n-1 cut points. */
export function inclusiveQuantiles(values: readonly number[], n: number): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  const m = sorted.length - 1;
  const cuts: number[] = [];
  for (let i = 1; i < n; i++) {
    const j = Math.floor((i * m) / n);
    const delta = (i * m) % n;
    cuts.push((sorted[j]! * (n - delta) + sorted[j + 1]! * delta) / n);
  }
  return cuts;
}
