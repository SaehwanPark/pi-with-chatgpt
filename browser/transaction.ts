/**
 * Process-wide serialization for operations that use the extension-owned adviser tab.
 *
 * A Playwright driver can serialize individual DOM operations, but a consultation is a transaction:
 * selecting a Project/conversation, navigating to it, sending the brief, and reading the answer must
 * remain together.  The production composition root may expose one browser bundle to more than one
 * workspace engine, so this lock lives above the driver and is shared by all of those engines.
 */

export interface BrowserTransactionScheduler {
  /** Run one complete browser transaction after all earlier transactions have released the tab. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Create a FIFO, process-local browser transaction scheduler.
 *
 * The implementation deliberately keeps the tail alive after failures.  A rejected consultation must
 * release the tab without poisoning the queue, otherwise every later workspace would remain blocked.
 */
export function createBrowserTransactionScheduler(): BrowserTransactionScheduler {
  let tail: Promise<void> = Promise.resolve();

  return {
    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release: () => void = () => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const scheduled = previous.catch(() => undefined).then(() => current);
      tail = scheduled;
      await previous.catch(() => undefined);
      try {
        return await operation();
      } finally {
        release();
        if (tail === scheduled) tail = Promise.resolve();
      }
    },
  };
}
