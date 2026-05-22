import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { promisifyCallback, onceOrError } from "../../src/util/promises.js";

describe("promisifyCallback", () => {
  it("resolves when callback receives null (4.a)", async () => {
    await expect(
      promisifyCallback((cb) => {
        cb(null);
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when callback receives an Error (4.b)", async () => {
    await expect(
      promisifyCallback((cb) => {
        cb(new Error("boom"));
      }),
    ).rejects.toThrow("boom");
  });

  it("resolves on both null and undefined callback args (4.c)", async () => {
    await expect(
      promisifyCallback((cb) => {
        cb(undefined);
      }),
    ).resolves.toBeUndefined();
    await expect(
      promisifyCallback((cb) => {
        cb(null);
      }),
    ).resolves.toBeUndefined();
  });
});

describe("onceOrError", () => {
  it("resolves on the success event (4.d)", async () => {
    const em = new EventEmitter();
    const p = onceOrError<string>(em, "ok", "err");
    em.emit("ok", "success-value");
    await expect(p).resolves.toBe("success-value");
  });

  it("rejects on the error event with the Error payload (4.e)", async () => {
    const em = new EventEmitter();
    const p = onceOrError(em, "ok", "err");
    em.emit("err", new Error("boom"));
    await expect(p).rejects.toThrow("boom");
  });

  it("removes both listeners after settling (4.f)", async () => {
    const em = new EventEmitter();
    const p = onceOrError(em, "ok", "err");
    em.emit("ok");
    await p;
    // After settling, both listeners must be removed — otherwise emitting
    // err here would surface as an unhandled rejection (vitest fails the
    // test on unhandled rejections).
    em.emit("err", new Error("late-error"));
    expect(em.listenerCount("ok")).toBe(0);
    expect(em.listenerCount("err")).toBe(0);
  });

  it("rejects with a generic Error when err event fires with no payload (4.g)", async () => {
    const em = new EventEmitter();
    const p = onceOrError(em, "ok", "err");
    em.emit("err");
    await expect(p).rejects.toThrow(/err fired with no payload/);
  });
});
