// Token generation and constant-time comparison.
//
// Tokens are `cb_live_` + 32 RFC 4648 base32 characters (alphabet A–Z + 2–7).
// Source entropy: 20 bytes from `node:crypto.randomBytes` → 160 bits → exactly
// 32 base32 chars (no padding needed because 160 is a multiple of 5).
//
// Per `patterns/project/constant-time-compare.md`, `constantTimeEqual` is the
// only way to compare a presented token against the canonical one — never
// `a === b`, which leaks length-of-match via early-exit timing.
//
// Q002 (base32 implementation source): hand-rolled (this file). No dep.

import { randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// RFC 4648 base32 encoder. Streams 5-bit groups out of the byte sequence.
// For our 20-byte input the trailing-bits branch never executes (160 % 5 = 0).
function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET.charAt((value >>> bits) & 0x1f);
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET.charAt((value << (5 - bits)) & 0x1f);
  }
  return result;
}

export function generateToken(): string {
  return `cb_live_${base32Encode(randomBytes(20))}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
