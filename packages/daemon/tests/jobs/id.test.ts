import { describe, it, expect } from "vitest";
import { generateJobId } from "../../src/jobs/id.js";

describe("generateJobId", () => {
  it("returns 'j_' + 12 RFC 4648 base32 chars", () => {
    const id = generateJobId();
    expect(id).toMatch(/^j_[A-Z2-7]{12}$/);
  });

  it("produces distinct IDs across 1000 invocations (collision check)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      set.add(generateJobId());
    }
    expect(set.size).toBe(1000);
  });
});
