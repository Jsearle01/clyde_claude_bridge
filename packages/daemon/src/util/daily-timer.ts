// Daily UTC-midnight-aligned timer shared by daemon subsystems that need
// once-per-day work (audit log rotation + pruning, job queue retention
// sweep, etc.). Extracted from T-0007's `AuditLog.startMidnightTimer` at
// T-P1-003 when JobQueue needed the same scheduling primitive — the
// "extract on third use" guideline would have gated this, but with two
// confirmed uses (AuditLog + JobQueue) sharing the same shape and a
// strong design preference for ONE daemon-wide daily timer, extraction
// at second use is justified per v0.4 §11.
//
// Pattern: schedule a setTimeout to next UTC midnight; on fire, invoke
// every registered callback sequentially, swallow per-callback errors via
// the onError hook (so one task's failure doesn't drop the others), then
// re-schedule. Callbacks may be sync or async; awaited in order.
//
// Test injection: pass `clock` to override `() => new Date()`. The setTimeout
// itself uses Node's wall clock — for ms-elapsed timer tests, vitest's
// vi.useFakeTimers() is the right tool; this module's clock injection is
// for the next-midnight calculation only.

export interface DailyTimerOpts {
  /** Test-injection clock; defaults to wall-clock `new Date()`. */
  clock?: () => Date;
  /** Called once per callback error during a fire cycle; defaults to no-op. */
  onError?: (err: unknown) => void;
}

export type DailyCallback = () => void | Promise<void>;

export class DailyTimer {
  private readonly clock: () => Date;
  private readonly onError: (err: unknown) => void;
  private readonly callbacks: DailyCallback[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: DailyTimerOpts = {}) {
    this.clock = opts.clock ?? ((): Date => new Date());
    this.onError = opts.onError ?? ((): void => undefined);
  }

  /** Register a callback to run at each UTC-midnight fire. Order of
   * registration is preserved when the timer fires. Adding callbacks
   * after `start()` is allowed; they take effect on the next fire. */
  add(cb: DailyCallback): void {
    this.callbacks.push(cb);
  }

  /** Schedule the first fire. Idempotent: calling twice does nothing. */
  start(): void {
    if (this.stopped || this.timer !== null) return;
    this.scheduleNext();
  }

  /** Cancel the pending fire. Safe to call multiple times; further
   * `start()` calls are no-ops after stop. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const now = this.clock();
    const tomorrow = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      ),
    );
    const ms = tomorrow.getTime() - now.getTime();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, ms);
  }

  private async fire(): Promise<void> {
    for (const cb of this.callbacks) {
      try {
        await cb();
      } catch (err) {
        this.onError(err);
      }
    }
    if (!this.stopped) this.scheduleNext();
  }
}
