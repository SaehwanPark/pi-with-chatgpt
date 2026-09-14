/**
 * Process-wide serialization for operations that use the extension-owned adviser tab.
 *
 * A Playwright driver can serialize individual DOM operations, but a consultation is a transaction:
 * selecting a Project/conversation, navigating to it, sending the brief, and reading the answer must
 * remain together. This scheduler therefore owns both FIFO admission and the deadman lease. A timeout
 * never releases the lock by itself: the caller must prove that the tracked browser was invalidated or
 * the scheduler remains poisoned and refuses reuse.
 */

export type BrowserTransactionFailure = "cancelled" | "transaction-timeout" | "browser-poisoned";

export class BrowserTransactionError extends Error {
  readonly code: BrowserTransactionFailure;
  readonly recovered: boolean;

  constructor(code: BrowserTransactionFailure, recovered = false) {
    super(`Adviser browser transaction ${code}.`);
    this.name = "BrowserTransactionError";
    this.code = code;
    this.recovered = recovered;
  }
}

export interface BrowserTransactionOptions {
  /** Abortable only while waiting for an earlier transaction. An active operation is not abandoned here. */
  readonly signal?: AbortSignal;
  /** Hard deadline for the active operation. The timeout starts once this request owns the tab. */
  readonly timeoutMs?: number;
  /** Out-of-band recovery invoked after the hard deadline, before the tab may be reused. */
  readonly onTimeout?: () => Promise<boolean>;
}

export interface BrowserTransactionScheduler {
  /** Run one complete browser transaction after all earlier transactions have released the tab. */
  runExclusive<T>(operation: () => Promise<T>, options?: BrowserTransactionOptions): Promise<T>;
  /** Whether recovery failed and future calls must fail fast instead of racing a stale browser owner. */
  isPoisoned?(): boolean;
}

/**
 * Create a FIFO, process-local browser transaction scheduler.
 *
 * The implementation deliberately keeps the tail alive after failures. A rejected consultation must
 * release the tab without poisoning the queue, otherwise every later workspace would remain blocked.
 * A timed-out operation is different: its promise may still be inside Playwright. It is only released
 * after `onTimeout` proves that the tracked context was closed; otherwise the scheduler becomes poisoned.
 */
export function createBrowserTransactionScheduler(): BrowserTransactionScheduler {
  let tail: Promise<void> = Promise.resolve();
  let poisoned = false;

  return {
    isPoisoned(): boolean {
      return poisoned;
    },

    async runExclusive<T>(operation: () => Promise<T>, options: BrowserTransactionOptions = {}): Promise<T> {
      if (poisoned) throw new BrowserTransactionError("browser-poisoned");
      if (options.signal?.aborted) throw new BrowserTransactionError("cancelled");

      const previous = tail;
      let release: () => void = () => undefined;
      let released = false;
      let admitted = false;
      const current = new Promise<void>((resolve) => {
        release = () => {
          if (released) return;
          released = true;
          resolve();
        };
      });
      const scheduled = previous.catch(() => undefined).then(() => current);
      tail = scheduled;

      try {
        await waitForAdmission(previous, options.signal);
        if (options.signal?.aborted) throw new BrowserTransactionError("cancelled");
        admitted = true;

        const running = Promise.resolve().then(operation);
        // Once the lease expires, the late operation is intentionally left attached so a rejection cannot
        // become an unhandled promise. Its result is discarded by the runtime generation barrier.
        const settled = running.then(
          (value) => ({ kind: "value" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );
        const result = options.timeoutMs === undefined
          ? await settled
          : await raceWithDeadline(settled, options.timeoutMs);

        if (result.kind === "error") throw result.error;
        return result.value;
      } catch (error) {
        if (error instanceof TransactionDeadline) {
          const recovered = await recoverAfterTimeout(options.onTimeout);
          if (!recovered) poisoned = true;
          throw new BrowserTransactionError(recovered ? "transaction-timeout" : "browser-poisoned", recovered);
        }
        throw error;
      } finally {
        release();
        if (tail === scheduled) {
          if (admitted) {
            tail = Promise.resolve();
          } else {
            // Keep the predecessor chain visible to later callers. Resetting `tail` immediately here
            // would let a new transaction bypass an older owner that is still running after this waiter
            // was cancelled.
            void scheduled.then(() => {
              if (tail === scheduled) tail = Promise.resolve();
            });
          }
        }
      }
    },
  };
}

class TransactionDeadline extends Error {
  constructor() {
    super("transaction deadline exceeded");
    this.name = "TransactionDeadline";
  }
}

async function waitForAdmission(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await previous.catch(() => undefined);
    return;
  }
  if (signal.aborted) throw new BrowserTransactionError("cancelled");

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new BrowserTransactionError("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous.catch(() => undefined), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function raceWithDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TransactionDeadline();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TransactionDeadline()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const RECOVERY_CALLBACK_GRACE_MS = 5_000;

async function recoverAfterTimeout(onTimeout: (() => Promise<boolean>) | undefined): Promise<boolean> {
  if (onTimeout === undefined) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      onTimeout(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), RECOVERY_CALLBACK_GRACE_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
