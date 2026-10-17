import { createHash } from 'node:crypto';

/** Stretch S5: 64-bit SimHash as 16 lowercase hex characters. */
export function simhashHex(text: string): string {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9\u0b80-\u0bff\u0900-\u097f]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const weights = new Array<number>(64).fill(0);
  if (tokens.length === 0) {
    return '0'.repeat(16);
  }
  for (const tok of tokens) {
    const h = tokenHash64(tok);
    for (let i = 0; i < 64; i++) {
      if ((h >> BigInt(i)) & 1n) weights[i] = (weights[i] ?? 0) + 1;
      else weights[i] = (weights[i] ?? 0) - 1;
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) {
    if ((weights[i] ?? 0) > 0) out |= 1n << BigInt(i);
  }
  return out.toString(16).padStart(16, '0');
}

/** Hamming distance between two 16-char hex SimHashes (0..64). */
export function hammingDistanceHex(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) {
    throw new Error('simhash values must be 16 lowercase hex characters');
  }
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let dist = 0;
  while (x > 0n) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist;
}

function tokenHash64(token: string): bigint {
  const digest = createHash('sha256').update(token).digest();
  return digest.readBigUInt64BE(0);
}
