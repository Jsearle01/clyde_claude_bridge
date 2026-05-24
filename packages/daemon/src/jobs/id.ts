// Job ID generation: "j_" + 12 RFC 4648 base32 characters from 8 random
// bytes (62 bits of entropy, truncated to 60 after the 12-char cap;
// effectively unique at any realistic project rate).
//
// Base32 implementation inlined here. This is the SECOND use of base32
// in the daemon (first: `packages/daemon/src/config/token.ts`). Per
// v0.4 §11 "extract on third confirmed use", extraction triggers when
// a third site appears. If a future task needs base32 again, extract
// to `packages/daemon/src/util/base32.ts` and update both sites.

import { randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

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

export function generateJobId(): string {
  // 8 random bytes = 64 bits → 13 base32 chars (last char carries 4 bits
  // of padding). Truncate to 12 for the documented 60-bit ID. Collision
  // probability is trivial at realistic project sizes.
  return `j_${base32Encode(randomBytes(8)).slice(0, 12)}`;
}
