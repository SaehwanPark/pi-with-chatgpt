/**
 * M3 — lifecycle of the one extension-owned browser.
 *
 * The rules this encodes are the ones that decide whether a consultation feels reliable: start lazily,
 * reuse what is healthy, notice a dead browser instead of waiting on it, and give up in a bounded amount
 * of time. All of it is expressed against {@link AdviserPageDriver}, so the tests run against a fake in
 * milliseconds and the real Playwright layer stays thin.
 *
 * Two invariants are structural rather than incidental:
 *
 * 1. **The caller cannot address the page.** There is no getter for a driver, no navigation method, no
 *    selector parameter anywhere in this class. A worker-facing surface can only call the five operations
 *    whose parameters are data ({@link consult}, {@link probeSurface}, {@link discoverModels},
 *    {@link status}, {@link shutdown}).
 * 2. **A human-gated state is terminal for this runtime.** Once a login or challenge is observed the
 *    runtime stops trying and says so; retry loops through a CAPTCHA are how an agent automates a human.
 */
import {
  DIAGNOSTIC_POLICY,
  type AdviserBrowserRuntime,
  type AdviserPageDriver,
  type ConsultationFailure,
  type ConsultationOutcome,
  type ConsultationRequest,
  type ModelOption,
  type RuntimePhase,
  type RuntimeRecoveryReason,
  type RuntimeRecoveryResult,
  type RuntimeRejection,
  type RuntimeStartOptions,
  type RuntimeStatus,
  type SurfaceObservation,
  type SurfaceState,
} from "./runtime-types.js";

export interface RuntimeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: RuntimeClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface AdviserRuntimeOptions {
  readonly driver: AdviserPageDriver;
  readonly profileDir: string;
  readonly clock?: RuntimeClock;
  /**
   * Consecutive failed starts before the runtime stops retrying without human help. Two is enough to
   * cover a transient failure while making a misconfigured profile fail fast enough to diagnose.
   */
  readonly maxConsecutiveLaunchFailures?: number;
  /** Backoff between launch attempts. */
  readonly launchBackoffMs?: number;
  /** Default bounded wait for one assistant turn. */
  readonly defaultTurnTimeoutMs?: number;
  /** Grace period for out-of-band context close after a transaction watchdog fires. */
  readonly recoveryGraceMs?: number;
}

const DEFAULT_MAX_LAUNCH_FAILURES = 2;
const DEFAULT_LAUNCH_BACKOFF_MS = 750;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const DEFAULT_RECOVERY_GRACE_MS = 5_000;

export type RuntimeEvent =
  | { readonly type: "launched"; readonly launchCount: number; readonly chromeVersion: string }
  | { readonly type: "launch-failed"; readonly rejection: RuntimeRejection; readonly attempt: number }
  | { readonly type: "recovered"; readonly reason: "unhealthy" | "stale-tab" }
  | { readonly type: "needs-human"; readonly explanation: string }
  /** A previously latched human gate cleared itself: someone signed in or solved a challenge. */
  | { readonly type: "human-cleared"; readonly state: SurfaceState }
  | { readonly type: "turn-failed"; readonly failure: ConsultationFailure }
  | { readonly type: "recovering"; readonly reason: RuntimeRecoveryReason }
  | { readonly type: "poisoned"; readonly reason: RuntimeRecoveryReason };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export class AdviserRuntime implements AdviserBrowserRuntime {
  #phase: RuntimePhase = "stopped";
  #headed = false;
  #launchCount = 0;
  #consecutiveLaunchFailures = 0;
  #chromeVersion: string | undefined;
  #lastFailure: RuntimeRejection | ConsultationFailure | undefined;
  #humanAttentionRequired = false;
  #poisoned = false;
  /**
   * One launch at a time. Without this, three concurrent consultations each see `phase === "stopped"` and
   * launch three browsers against one profile — the second and third fail with a profile lock, and the
   * error looks like a Chrome bug.
   */
  #launchInFlight: Promise<{ readonly ok: boolean; readonly rejection?: RuntimeRejection }> | undefined;
  /** Consultations are serialised: one tab, one composer, one turn at a time. */
  #turnQueue: Promise<unknown> = Promise.resolve();
  /** Monotonic barrier: shutdown invalidates turns that were queued before it. */
  #turnGeneration = 0;
  readonly #listeners = new Set<RuntimeEventListener>();

  readonly #driver: AdviserPageDriver;
  readonly #profileDir: string;
  readonly #clock: RuntimeClock;
  readonly #maxLaunchFailures: number;
  readonly #launchBackoffMs: number;
  readonly #defaultTurnTimeoutMs: number;
  readonly #recoveryGraceMs: number;

  constructor(options: AdviserRuntimeOptions) {
    this.#driver = options.driver;
    this.#profileDir = options.profileDir;
    this.#clock = options.clock ?? systemClock;
    this.#maxLaunchFailures = options.maxConsecutiveLaunchFailures ?? DEFAULT_MAX_LAUNCH_FAILURES;
    this.#launchBackoffMs = options.launchBackoffMs ?? DEFAULT_LAUNCH_BACKOFF_MS;
    this.#defaultTurnTimeoutMs = options.defaultTurnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.#recoveryGraceMs = options.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS;
  }

  /** Events exist for the status line and the ledger; a listener must never break the runtime. */
  subscribe(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async status(): Promise<RuntimeStatus> {
    if (this.#poisoned) return this.#statusSnapshot(false);
    return await this.#driver.runExclusive(async () => {
      const processAlive = this.#phase === "ready" || this.#phase === "degraded" ? await this.#safeHealth() : false;
      return this.#statusSnapshot(processAlive);
    });
  }

  async ensureReady(options: RuntimeStartOptions = { purpose: "consultation" }): Promise<{
    readonly ok: boolean;
    readonly rejection?: RuntimeRejection;
  }> {
    if (this.#poisoned) return { ok: false, rejection: "browser-poisoned" };
    const generation = this.#turnGeneration;
    return await this.#driver.runExclusive(() => this.#ensureReady(options, generation));
  }

  async probeSurface(): Promise<SurfaceObservation> {
    const generation = this.#turnGeneration;
    return await this.#driver.runExclusive(async () => {
      const ready = await this.#ensureReady({ purpose: "capability-probe" }, generation);
      if (!ready.ok) {
        return {
          state: "unknown",
          explanation: `Browser unavailable (${ready.rejection ?? "unknown"}).`,
          actionable: false,
        };
      }
      // Open the ChatGPT surface before classifying it: a freshly launched tab is `about:blank`, and a
      // classifier that ran there would report "not ChatGPT" about a page it never navigated to.
      return this.#surface();
    });
  }

  async discoverModels(): Promise<{
    readonly ok: boolean;
    readonly models?: readonly ModelOption[];
    readonly rejection?: RuntimeRejection;
  }> {
    const generation = this.#turnGeneration;
    return await this.#driver.runExclusive(async () => {
      const ready = await this.#ensureReady({ purpose: "model-discovery" }, generation);
      if (!ready.ok) return { ok: false, rejection: ready.rejection ?? "launch-failed" };
      const surface = await this.#surface();
      if (!surface.actionable) return { ok: false, rejection: "needs-human" };
      return { ok: true, models: await this.#driver.listModels() };
    });
  }

  /** Internal form: callers that already own the driver operation lock use this to avoid a nested lock. */
  async #ensureReady(options: RuntimeStartOptions, generation = this.#turnGeneration): Promise<{
    readonly ok: boolean;
    readonly rejection?: RuntimeRejection;
  }> {
    if (!this.#generationIsCurrent(generation)) {
      return { ok: false, rejection: this.#staleRejection() };
    }
    if (this.#poisoned || this.#phase === "poisoned") {
      return { ok: false, rejection: "browser-poisoned" };
    }
    if (this.#phase === "failed") {
      // Launch retries are exhausted. This is the only latch that refuses a launch attempt: it is a
      // proven transport failure, unlike the human gate, which is only an expectation about the page.
      return { ok: false, rejection: "launch-failed" };
    }
    let contextDiscarded = false;
    if (this.#phase === "ready") {
      const healthy = await this.#driver.isHealthy();
      if (!this.#generationIsCurrent(generation)) return { ok: false, rejection: this.#staleRejection() };
      const modeMatches = options.headed === undefined || (options.headed === true) === this.#headed;
      if (healthy && modeMatches) return { ok: true };
      if (!healthy) {
        // The common production surprise: the process is gone but the object graph still says "ready".
        this.#phase = "degraded";
        this.#emit({ type: "recovered", reason: "unhealthy" });
      }
      // Do not let start() reuse a renderer that answered the health check as unhealthy or whose
      // display mode differs (headless vs headed). Discard the complete context first; the driver
      // owns the profile lock and will reacquire it on relaunch.
      await this.#driver.shutdown().catch(() => undefined);
      if (!this.#generationIsCurrent(generation)) return { ok: false, rejection: this.#staleRejection() };
      contextDiscarded = true;
    }
    if (this.#phase === "degraded" && !contextDiscarded) {
      // A turn can mark the runtime degraded after a driver exception without a preceding health check.
      // The next attempt must not hand that potentially hung context back to start().
      await this.#driver.shutdown().catch(() => undefined);
      if (!this.#generationIsCurrent(generation)) return { ok: false, rejection: this.#staleRejection() };
    }
    return await this.#launchOrReuse(options, generation);
  }

  /**
   * Ask one question and wait for one answer.
   *
   * The turn is queued rather than concurrent, and the failure path distinguishes "the browser died" from
   * "the model refused" from "we timed out": a caller must know whether retrying could help.
   */
  async consult(request: ConsultationRequest): Promise<ConsultationOutcome> {
    if (this.#poisoned) return { ok: false, failure: "browser-poisoned" };
    if (request.signal?.aborted) return { ok: false, failure: "cancelled" };

    const generation = this.#turnGeneration;
    const previous = this.#turnQueue;
    const run = (async (): Promise<ConsultationOutcome> => {
      try {
        await waitForTurnAdmission(previous, request.signal);
      } catch {
        return { ok: false, failure: "cancelled" };
      }
      if (request.signal?.aborted) return { ok: false, failure: "cancelled" };
      if (generation !== this.#turnGeneration) {
        return { ok: false, failure: this.#poisoned ? "browser-poisoned" : "browser-lost" };
      }
      return await this.#driver.runExclusive(() => this.#runTurn(request, generation));
    })();
    // Keep the queue alive regardless of how this turn ends; a rejected promise here would poison it.
    const queued = run.then(
      () => undefined,
      () => undefined,
    );
    this.#turnQueue = queued;
    return await run;
  }

  async shutdown(): Promise<void> {
    // Invalidate queued turns before waiting for the driver lock. The active turn is allowed to unwind;
    // turns behind it must not observe `stopped` and relaunch a browser after shutdown completes.
    this.#turnGeneration += 1;
    this.#turnQueue = Promise.resolve();
    await this.#driver.runExclusive(async () => {
      if (this.#phase === "stopped" || this.#phase === "poisoned") return;
      this.#phase = "stopping";
      try {
        await this.#driver.shutdown();
      } finally {
        this.#phase = "stopped";
        this.#chromeVersion = undefined;
      }
    });
  }

  async emergencyRecover(reason: RuntimeRecoveryReason): Promise<RuntimeRecoveryResult> {
    if (this.#poisoned) return { ok: false, reusable: false, generation: this.#turnGeneration };
    this.#turnGeneration += 1;
    this.#turnQueue = Promise.resolve();
    this.#phase = "degraded";
    this.#lastFailure = reason === "transaction-timeout" ? "transaction-timeout" : "browser-unresponsive";
    this.#emit({ type: "recovering", reason });

    let close: Promise<void>;
    try {
      close = this.#driver.emergencyClose?.() ?? this.#driver.shutdown();
    } catch {
      close = Promise.reject(new Error("emergency close failed"));
    }
    const settled = await settleWithin(close, this.#recoveryGraceMs);
    if (!settled) {
      this.#poisoned = true;
      this.#phase = "poisoned";
      this.#lastFailure = "browser-poisoned";
      this.#emit({ type: "poisoned", reason });
      return { ok: false, reusable: false, generation: this.#turnGeneration };
    }

    this.#poisoned = false;
    this.#phase = "stopped";
    this.#chromeVersion = undefined;
    this.#lastFailure = undefined;
    this.#emit({ type: "recovered", reason: "stale-tab" });
    return { ok: true, reusable: true, generation: this.#turnGeneration };
  }

  async #runTurn(request: ConsultationRequest, generation: number): Promise<ConsultationOutcome> {
    if (request.signal?.aborted) return { ok: false, failure: "cancelled" };

    const ready = await this.#ensureReady({ purpose: "consultation" });
    if (this.#stale(generation, request.signal)) return { ok: false, failure: this.#staleFailure(generation) };
    if (!ready.ok) {
      // Report the reason the browser could not start. A remembered human gate is not the cause here,
      // and reporting it would send the user to fix a login while Chrome is what is actually missing.
      const failure: ConsultationFailure =
        ready.rejection === "needs-human"
          ? "needs-human"
          : ready.rejection === "browser-poisoned"
            ? "browser-poisoned"
            : "browser-lost";
      this.#lastFailure = failure;
      this.#emit({ type: "turn-failed", failure });
      return { ok: false, failure };
    }

    const surface = await this.#surface();
    if (this.#stale(generation, request.signal)) return { ok: false, failure: this.#staleFailure(generation) };
    if (!surface.actionable) {
      this.#lastFailure = "needs-human";
      this.#emit({ type: "turn-failed", failure: "needs-human" });
      return { ok: false, failure: "needs-human" };
    }

    const modelSelected = await this.#driver.selectModel(request.modelId);
    if (this.#stale(generation, request.signal)) return { ok: false, failure: this.#staleFailure(generation) };
    if (!modelSelected) {
      this.#lastFailure = "model-unavailable";
      this.#emit({ type: "turn-failed", failure: "model-unavailable" });
      return { ok: false, failure: "model-unavailable" };
    }

    const startedAt = this.#clock.now();
    let outcome: ConsultationOutcome;
    try {
      outcome = await this.#driver.askAndAwaitTurn({
        ...request,
        timeoutMs: request.timeoutMs ?? this.#defaultTurnTimeoutMs,
      });
    } catch {
      // A timed-out generation may throw after emergency recovery has already started a fresh one. Check
      // the barrier before mutating shared runtime state, otherwise a late old turn could mark the new
      // browser degraded after it was proven ready.
      if (this.#stale(generation, request.signal)) return { ok: false, failure: this.#staleFailure(generation) };
      // A driver throw means the browser or page died under us, not that the adviser said no.
      this.#phase = "degraded";
      this.#lastFailure = "browser-lost";
      this.#emit({ type: "turn-failed", failure: "browser-lost" });
      return { ok: false, failure: "browser-lost" };
    }

    if (this.#stale(generation, request.signal)) return { ok: false, failure: this.#staleFailure(generation) };

    if (!outcome.ok) {
      this.#lastFailure = outcome.failure;
      this.#emit({ type: "turn-failed", failure: outcome.failure });
      if (outcome.failure === "browser-lost") this.#phase = "degraded";
      if (outcome.failure === "needs-human") this.#humanAttentionRequired = true;
    } else {
      this.#consecutiveLaunchFailures = 0;
      this.#lastFailure = undefined;
      // A completed turn is proof the tab is live, so the measured elapsed time is the only thing to keep.
      return { ...outcome, elapsedMs: this.#clock.now() - startedAt };
    }
    return outcome;
  }

  #generationIsCurrent(generation: number): boolean {
    return generation === this.#turnGeneration && !this.#poisoned;
  }

  #staleRejection(): RuntimeRejection {
    return this.#poisoned ? "browser-poisoned" : "launch-failed";
  }

  #stale(generation: number, signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true || !this.#generationIsCurrent(generation);
  }

  #staleFailure(generation: number): ConsultationFailure {
    if (this.#poisoned) return "browser-poisoned";
    if (generation !== this.#turnGeneration) return "browser-lost";
    return "cancelled";
  }

  #statusSnapshot(processAlive: boolean): RuntimeStatus {
    return {
      phase: this.#phase,
      processAlive,
      headed: this.#headed,
      profileDir: this.#profileDir,
      ...(this.#chromeVersion === undefined ? {} : { chromeVersion: this.#chromeVersion }),
      launchCount: this.#launchCount,
      ...(this.#lastFailure === undefined ? {} : { lastFailure: this.#lastFailure }),
      humanAttentionRequired: this.#humanAttentionRequired,
    };
  }

  async #launchOrReuse(
    options: RuntimeStartOptions,
    generation = this.#turnGeneration,
  ): Promise<{ ok: boolean; rejection?: RuntimeRejection }> {
    if (!this.#generationIsCurrent(generation)) return { ok: false, rejection: this.#staleRejection() };
    if (this.#launchInFlight) {
      const result = await this.#launchInFlight;
      return this.#generationIsCurrent(generation) ? result : { ok: false, rejection: this.#staleRejection() };
    }

    const launch = this.#launch(options, generation);
    this.#launchInFlight = launch;
    try {
      const result = await launch;
      return this.#generationIsCurrent(generation) ? result : { ok: false, rejection: this.#staleRejection() };
    } finally {
      this.#launchInFlight = undefined;
    }
  }

  async #launch(
    options: RuntimeStartOptions,
    generation = this.#turnGeneration,
  ): Promise<{ ok: boolean; rejection?: RuntimeRejection }> {
    if (!this.#generationIsCurrent(generation)) return { ok: false, rejection: this.#staleRejection() };
    if (this.#consecutiveLaunchFailures >= this.#maxLaunchFailures) {
      this.#phase = "failed";
      this.#lastFailure = "launch-failed";
      return { ok: false, rejection: "launch-failed" };
    }

    this.#phase = "starting";
    this.#headed = options.headed === true;
    try {
      const { chromeVersion } = await this.#driver.start({ ...options, headed: this.#headed });
      if (!this.#generationIsCurrent(generation)) return { ok: false, rejection: this.#staleRejection() };
      this.#launchCount += 1;
      this.#consecutiveLaunchFailures = 0;
      this.#chromeVersion = chromeVersion;
      this.#phase = "ready";
      this.#lastFailure = undefined;
      this.#emit({ type: "launched", launchCount: this.#launchCount, chromeVersion });
      return { ok: true };
    } catch (error) {
      if (!this.#generationIsCurrent(generation)) return { ok: false, rejection: this.#staleRejection() };
      this.#consecutiveLaunchFailures += 1;
      const rejection = rejectionFromError(error);
      this.#phase = this.#consecutiveLaunchFailures >= this.#maxLaunchFailures ? "failed" : "stopped";
      this.#lastFailure = rejection;
      this.#emit({ type: "launch-failed", rejection, attempt: this.#consecutiveLaunchFailures });
      if (this.#consecutiveLaunchFailures < this.#maxLaunchFailures) {
        await this.#clock.sleep(this.#launchBackoffMs);
      }
      return { ok: false, rejection };
    }
  }

  /**
   * The ChatGPT surface, opened if the current tab is not already on it.
   *
   * `openChatGPT` is idempotent: it re-reads an on-surface tab instead of reloading and losing a partial
   * login state. Routing every classification through it is what stops `about:blank` from being reported
   * as "not the ChatGPT surface".
   */
  async #surface(): Promise<SurfaceObservation> {
    const observation = await this.#driver.openChatGPT();
    // Opening the surface is itself an observation: if it came back actionable, whoever was needed has
    // acted. Latching the first `signed-out` forever would deadlock the login flow it just enabled.
    return this.#noteHumanGate(observation);
  }

  async #safeHealth(): Promise<boolean> {
    try {
      return await this.#driver.isHealthy();
    } catch {
      return false;
    }
  }

  /**
   * Track whether a person is required, from a fresh observation rather than from a latch.
   *
   * The gate has to be *re-evaluated*, not remembered as a refusal. A login window is opened precisely
   * while the page reads `signed-out`; if that observation closed the door, the later observation that
   * must notice the human finished would be refused, and manual login could never complete. Reading the
   * page again is not automating a challenge — it asks nothing of it — so observation stays available
   * while `consult()` refuses, which is where the real "do not push through a human gate" rule bites.
   */
  #noteHumanGate(observation: SurfaceObservation): SurfaceObservation {
    const needsHuman = !observation.actionable;
    if (needsHuman && !this.#humanAttentionRequired) {
      this.#humanAttentionRequired = true;
      this.#emit({ type: "needs-human", explanation: observation.explanation ?? observation.state });
    } else if (!needsHuman && this.#humanAttentionRequired) {
      this.#humanAttentionRequired = false;
      this.#emit({ type: "human-cleared", state: observation.state });
    }
    return observation;
  }

  #emit(event: RuntimeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not take the runtime down with it.
      }
    }
  }
}

async function waitForTurnAdmission(previous: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await previous.catch(() => undefined);
    return;
  }
  if (signal.aborted) throw new Error("cancelled");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous.catch(() => undefined), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Playwright throws with prose; map the cases where the remedy differs. */
function rejectionFromError(error: unknown): RuntimeRejection {
  const message = error instanceof Error ? error.message : String(error);
  if (/executable doesn't exist|can't find chrome|not found/iu.test(message)) return "chrome-not-found";
  if (/process.*(?:lock|holds)|state-busy|profile lock|user data directory is already in use|singletonlock/iu.test(message)) {
    return "profile-locked-by-other-process";
  }
  if (/eperm|eacces|userdata|user data/iu.test(message)) return "profile-unusable";
  return "launch-failed";
}

/** Exported so the diagnostics writer and its test agree on one number. */
export const DIAGNOSTIC_RETENTION_MS = DIAGNOSTIC_POLICY.retentionMs;
