import { describe, it, expect } from "vitest";
import { hashInput } from "../../src/audit/hash.js";

const HASH_FORMAT = /^sha256:[a-f0-9]{64}$/;

describe("hashInput", () => {
  it("produces the same hash for the same input (10.a)", () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ a: 1, b: 2 }));
  });

  it("is independent of top-level key order (10.b)", () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
  });

  it("is independent of nested key order — recursive canonicalization (10.c)", () => {
    expect(hashInput({ a: { b: 1, c: 2 } })).toBe(
      hashInput({ a: { c: 2, b: 1 } }),
    );
  });

  it("produces different hashes for different content (10.d)", () => {
    expect(hashInput({ a: 1, b: 2 })).not.toBe(hashInput({ a: 1, b: 3 }));
  });

  it("handles non-object inputs without throwing (10.e)", () => {
    expect(hashInput(null)).toMatch(HASH_FORMAT);
    expect(hashInput(undefined)).toMatch(HASH_FORMAT);
    expect(hashInput("hello")).toMatch(HASH_FORMAT);
    expect(hashInput(42)).toMatch(HASH_FORMAT);
  });

  it("output format is 'sha256:' + 64 hex chars (10.f)", () => {
    expect(hashInput({ a: 1 })).toMatch(HASH_FORMAT);
    expect(hashInput([1, 2, 3])).toMatch(HASH_FORMAT);
    expect(hashInput("anything")).toMatch(HASH_FORMAT);
  });

  it("treats array order as semantic — order matters (10.g)", () => {
    expect(hashInput([1, 2, 3])).not.toBe(hashInput([3, 2, 1]));
  });
});
