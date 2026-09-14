import { describe, expect, it } from "vitest";

import { BrowserTransactionError, createBrowserTransactionScheduler } from "./transaction.js";

const never = (): Promise<void> => new Promise<void>(() => undefined);

describe("browser transaction scheduler", () => {
  it("settles a queued waiter when its signal is aborted", async () => {
    const scheduler = createBrowserTransactionScheduler();
    let releaseFirst: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstRun = scheduler.runExclusive(async () => {
      await first;
    });
    const controller = new AbortController();
    const waiting = scheduler.runExclusive(() => Promise.resolve(), { signal: controller.signal });

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
    releaseFirst();
    await firstRun;

    await expect(scheduler.runExclusive(() => Promise.resolve("next"))).resolves.toBe("next");
  });

  it("recovers before releasing a timed-out transaction", async () => {
    const scheduler = createBrowserTransactionScheduler();
    let recovered = 0;
    const timedOut = scheduler.runExclusive(never, {
      timeoutMs: 10,
      onTimeout: () => {
        recovered += 1;
        return Promise.resolve(true);
      },
    });

    await expect(timedOut).rejects.toMatchObject({
      code: "transaction-timeout",
      recovered: true,
    });
    expect(recovered).toBe(1);
    await expect(scheduler.runExclusive(() => Promise.resolve("fresh generation"))).resolves.toBe("fresh generation");
  });

  it("poisons the scheduler when recovery cannot prove ownership is safe", async () => {
    const scheduler = createBrowserTransactionScheduler();
    await expect(scheduler.runExclusive(never, { timeoutMs: 10, onTimeout: () => Promise.resolve(false) })).rejects.toBeInstanceOf(
      BrowserTransactionError,
    );
    expect(scheduler.isPoisoned?.()).toBe(true);
    await expect(scheduler.runExclusive(() => Promise.resolve())).rejects.toMatchObject({ code: "browser-poisoned" });
  });
});
