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
import { DIAGNOSTIC_POLICY, type AdviserBrowserRuntime, type AdviserPageDriver, type ConsultationFailure, type ConsultationOutcome, type ConsultationRequest, type ModelOption, type RuntimePhase, type RuntimeRejection, type RuntimeStartOptions, type RuntimeStatus, type SurfaceObservation } from "./runtime-types.js";

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
}

const DEFAULT_MAX_LAUNCH_FAILURES = 2;
const DEFAULT_LAUNCH_BACKOFF_MS = 750;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;

export type RuntimeEvent =
  | { readonly type: "launched"; readonly launchCount: number; readonly chromeVersion: string }
  | { readonly type: "launch-failed"; readonly rejection: RuntimeRejection; readonly attempt: number }
  | { readonly type: "recovered"; readonly reason: "unhealthy" | "stale-tab" }
  | { readonly type: "needs-human"; readonly explanation: string }
  | { readonly type: "turn-failed"; readonly failure: ConsultationFailure };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export class AdviserRuntime implements AdviserBrowserRuntime {
  #phase: RuntimePhase = "stopped";
  #headed = false;
  #launchCount = 0;
  #consecutiveLaunchFailures = 0;
  #chromeVersion: string | undefined;
  #lastFailure: RuntimeRejection | ConsultationFailure | undefined;
  #humanAttentionRequired = false;
  /**
   * One launch at a time. Without this, three concurrent consultations each see `phase === "stopped"` and
   * launch three browsers against one profile — the second and third fail with a profile lock, and the
   * error looks like a Chrome bug.
   */
  #launchInFlight: Promise<{ readonly ok: boolean; readonly rejection?: RuntimeRejection }> | undefined;
  /** Consultations are serialised: one tab, one composer, one turn at a time. */
  #turnQueue: Promise<unknown> = Promise.resolve();
  readonly #listeners = new Set<RuntimeEventListener>();

  readonly #driver: AdviserPageDriver;
  readonly #profileDir: string;
  readonly #clock: RuntimeClock;
  readonly #maxLaunchFailures: number;
  readonly #launchBackoffMs: number;
  readonly #defaultTurnTimeoutMs: number;

  constructor(options: AdviserRuntimeOptions) {
    this.#driver = options.driver;
    this.#profileDir = options.profileDir;
    this.#clock = options.clock ?? systemClock;
    this.#maxLaunchFailures = options.maxConsecutiveLaunchFailures ?? DEFAULT_MAX_LAUNCH_FAILURES;
    this.#launchBackoffMs = options.launchBackoffMs ?? DEFAULT_LAUNCH_BACKOFF_MS;
    this.#defaultTurnTimeoutMs = options.defaultTurnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  /** Events exist for the status line and the ledger; a listener must never break the runtime. */
  subscribe(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async status(): Promise<RuntimeStatus> {
    const processAlive = this.#phase === "ready" || this.#phase === "degraded" ? await this.#safeHealth() : false;
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

  async ensureReady(options: RuntimeStartOptions = { purpose: "consultation" }): Promise<{
    readonly ok: boolean;
    readonly rejection?: RuntimeRejection;
  }> {
    if (this.#humanAttentionRequired) {
      // A challenge does not resolve itself; report rather than relaunch into the same page.
      return { ok: false, rejection: "needs-human" };
    }
    if (this.#phase === "ready") {
      if (await this.#driver.isHealthy()) return { ok: true };
      // The common production surprise: the process is gone but the object graph still says "ready".
      this.#phase = "degraded";
      this.#emit({ type: "recovered", reason: "unhealthy" });
    }
    return await this.#launchOrReuse(options);
  }

  async probeSurface(): Promise<SurfaceObservation> {
    const ready = await this.ensureReady({ purpose: "capability-probe" });
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
  }

  async discoverModels(): Promise<{
    readonly ok: boolean;
    readonly models?: readonly ModelOption[];
    readonly rejection?: RuntimeRejection;
  }> {
    const ready = await this.ensureReady({ purpose: "model-discovery" });
    if (!ready.ok) return { ok: false, rejection: ready.rejection ?? "launch-failed" };
    const surface = await this.#surface();
    if (!surface.actionable) return { ok: false, rejection: "needs-human" };
    return { ok: true, models: await this.#driver.listModels() };
  }

  /**
   * Ask one question and wait for one answer.
   *
   * The turn is queued rather than concurrent, and the failure path distinguishes "the browser died" from
   * "the model refused" from "we timed out": a caller must know whether retrying could help.
   */
  async consult(request: ConsultationRequest): Promise<ConsultationOutcome> {
    const run = this.#turnQueue.then(() => this.#runTurn(request));
    // Keep the queue alive regardless of how this turn ends; a rejected promise here would poison it.
    this.#turnQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async shutdown(): Promise<void> {
    if (this.#phase === "stopped") return;
    this.#phase = "stopping";
    try {
      await this.#driver.shutdown();
    } finally {
      this.#phase = "stopped";
      this.#chromeVersion = undefined;
    }
  }

  async #runTurn(request: ConsultationRequest): Promise<ConsultationOutcome> {
    const ready = await this.ensureReady({ purpose: "consultation" });
    if (!ready.ok) {
      const failure = this.#humanAttentionRequired ? "needs-human" : "browser-lost";
      this.#lastFailure = failure;
      this.#emit({ type: "turn-failed", failure });
      return { ok: false, failure };
    }

    const surface = await this.#surface();
    if (!surface.actionable) {
      this.#lastFailure = "needs-human";
      this.#emit({ type: "turn-failed", failure: "needs-human" });
      return { ok: false, failure: "needs-human" };
    }

    if (!(await this.#driver.selectModel(request.modelId))) {
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
      // A driver throw means the browser or page died under us, not that the adviser said no.
      this.#phase = "degraded";
      this.#lastFailure = "browser-lost";
      this.#emit({ type: "turn-failed", failure: "browser-lost" });
      return { ok: false, failure: "browser-lost" };
    }

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

  async #launchOrReuse(options: RuntimeStartOptions): Promise<{ ok: boolean; rejection?: RuntimeRejection }> {
    if (this.#launchInFlight) return await this.#launchInFlight;

    const launch = this.#launch(options);
    this.#launchInFlight = launch;
    try {
      return await launch;
    } finally {
      this.#launchInFlight = undefined;
    }
  }

  async #launch(options: RuntimeStartOptions): Promise<{ ok: boolean; rejection?: RuntimeRejection }> {
    if (this.#consecutiveLaunchFailures >= this.#maxLaunchFailures) {
      this.#phase = "failed";
      this.#lastFailure = "launch-failed";
      return { ok: false, rejection: "launch-failed" };
    }

    this.#phase = "starting";
    this.#headed = options.headed === true;
    try {
      const { chromeVersion } = await this.#driver.start({ ...options, headed: this.#headed });
      this.#launchCount += 1;
      this.#consecutiveLaunchFailures = 0;
      this.#chromeVersion = chromeVersion;
      this.#phase = "ready";
      this.#lastFailure = undefined;
      this.#emit({ type: "launched", launchCount: this.#launchCount, chromeVersion });
      return { ok: true };
    } catch (error) {
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
    return this.#noteHumanGate(await this.#driver.openChatGPT());
  }

  async #safeHealth(): Promise<boolean> {
    try {
      return await this.#driver.isHealthy();
    } catch {
      return false;
    }
  }

  /** Record, and report once, that a person is now required. */
  #noteHumanGate(observation: SurfaceObservation): SurfaceObservation {
    if (observation.state === "human-verification" || observation.state === "signed-out") {
      this.#humanAttentionRequired = true;
      this.#emit({ type: "needs-human", explanation: observation.explanation ?? observation.state });
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

/** Playwright throws with prose; map the cases where the remedy differs. */
function rejectionFromError(error: unknown): RuntimeRejection {
  const message = error instanceof Error ? error.message : String(error);
  if (/executable doesn't exist|can't find chrome|not found/iu.test(message)) return "chrome-not-found";
  if (/process.*lock|user data directory is already in use|singletonlock/iu.test(message)) {
    return "profile-locked-by-other-process";
  }
  if (/eperm|eacces|userdata|user data/iu.test(message)) return "profile-unusable";
  return "launch-failed";
}

/** Exported so the diagnostics writer and its test agree on one number. */
export const DIAGNOSTIC_RETENTION_MS = DIAGNOSTIC_POLICY.retentionMs;
