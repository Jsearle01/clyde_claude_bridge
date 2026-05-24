import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DailyTimer } from "../../src/util/daily-timer.js";

describe("DailyTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules a fire at the next UTC midnight relative to the injected clock", () => {
    // Clock pinned to 2026-05-23T23:30:00Z → next midnight is 30 min away.
    const now = new Date("2026-05-23T23:30:00Z");
    const t = new DailyTimer({ clock: (): Date => now });
    t.start();
    expect(vi.getTimerCount()).toBe(1);
    t.stop();
  });

  it("invokes registered callbacks in order when the timer fires", async () => {
    const calls: string[] = [];
    const t = new DailyTimer({
      clock: (): Date => new Date("2026-05-23T23:59:59.000Z"),
    });
    t.add(() => {
      calls.push("a");
    });
    t.add(async () => {
      await Promise.resolve();
      calls.push("b");
    });
    t.add(() => {
      calls.push("c");
    });
    t.start();
    await vi.runOnlyPendingTimersAsync();
    expect(calls).toEqual(["a", "b", "c"]);
    t.stop();
  });

  it("re-schedules after each fire (chain continues)", async () => {
    const t = new DailyTimer({
      clock: (): Date => new Date("2026-05-23T23:59:59.000Z"),
    });
    t.add(() => undefined);
    t.start();
    await vi.runOnlyPendingTimersAsync();
    // After fire, a new timer should be scheduled.
    expect(vi.getTimerCount()).toBe(1);
    t.stop();
  });

  it("routes callback errors through onError without aborting the chain", async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const t = new DailyTimer({
      clock: (): Date => new Date("2026-05-23T23:59:59.000Z"),
      onError: (err) => errors.push(err),
    });
    t.add(() => {
      calls.push("first");
      throw new Error("boom");
    });
    t.add(() => {
      calls.push("second");
    });
    t.start();
    await vi.runOnlyPendingTimersAsync();
    expect(calls).toEqual(["first", "second"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    t.stop();
  });

  it("stop cancels the pending timer", () => {
    const t = new DailyTimer({
      clock: (): Date => new Date("2026-05-23T23:59:59.000Z"),
    });
    t.start();
    expect(vi.getTimerCount()).toBe(1);
    t.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("start after stop is a no-op", () => {
    const t = new DailyTimer({
      clock: (): Date => new Date("2026-05-23T23:59:59.000Z"),
    });
    t.start();
    t.stop();
    t.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not re-schedule if stopped during fire", async () => {
    const t = new DailyTimer({
      clock: (): Date => new Date("2026-05-23T23:59:59.000Z"),
    });
    t.add(() => {
      t.stop();
    });
    t.start();
    await vi.runOnlyPendingTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });
});
