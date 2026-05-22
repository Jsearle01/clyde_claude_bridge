import { describe, it, expect } from "vitest";
import { PingInputSchema } from "../src/index.js";

describe("PingInputSchema", () => {
  it("parses a valid input with a message (6.a)", () => {
    const result = PingInputSchema.parse({ message: "hello" });
    expect(result.message).toBe("hello");
  });

  it("parses an empty input — message is optional (6.b)", () => {
    const result = PingInputSchema.parse({});
    expect(result.message).toBeUndefined();
  });

  it("rejects a message longer than 1024 characters (6.c)", () => {
    const tooLong = "x".repeat(1025);
    expect(PingInputSchema.safeParse({ message: tooLong }).success).toBe(false);
  });

  it("rejects extra unknown fields — .strict() (6.d)", () => {
    expect(
      PingInputSchema.safeParse({ message: "hi", extra: 1 }).success,
    ).toBe(false);
  });
});
