import { describe, it, expect } from "vitest";
import { generateToken, constantTimeEqual } from "../../src/config/token.js";

const TOKEN_FORMAT = /^cb_live_[A-Z2-7]{32}$/;
const INERT_TOKEN_A = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INERT_TOKEN_B = "cb_live_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("generateToken", () => {
  it("produces 'cb_live_' + 32 base32 chars across 1000 generations (11.a)", () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateToken()).toMatch(TOKEN_FORMAT);
    }
  });

  it("produces 1000 distinct tokens — entropy sanity (11.b)", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) tokens.add(generateToken());
    expect(tokens.size).toBe(1000);
  });

  it("uses only the RFC 4648 base32 alphabet (A–Z, 2–7) (11.c)", () => {
    const valid = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
    for (let i = 0; i < 1000; i++) {
      const token = generateToken();
      const tail = token.slice("cb_live_".length);
      for (const c of tail) {
        expect(valid.has(c)).toBe(true);
      }
    }
  });
});

describe("constantTimeEqual", () => {
  it("returns true for identical strings (11.d)", () => {
    expect(constantTimeEqual("hello", "hello")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for strings of different lengths (11.e)", () => {
    expect(constantTimeEqual("hello", "hello!")).toBe(false);
    expect(constantTimeEqual("hi", "hello")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });

  it("returns false for equal-length strings differing by one char (11.f)", () => {
    expect(constantTimeEqual("hello", "hellp")).toBe(false);
    expect(constantTimeEqual("abcd", "abce")).toBe(false);
  });

  it("works correctly with inert conforming tokens (11.g)", () => {
    expect(constantTimeEqual(INERT_TOKEN_A, INERT_TOKEN_A)).toBe(true);
    expect(constantTimeEqual(INERT_TOKEN_A, INERT_TOKEN_B)).toBe(false);
  });
});
