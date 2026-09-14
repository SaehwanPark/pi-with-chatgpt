/**
 * Small process-local circuit breaker for the shared adviser transport.
 *
 * This is deliberately not a general resilience framework. It remembers only recent browser/provider
 * failures, is never persisted, and requires a successful half-open request before closing again. Auth,
 * capability, human-verification, provenance, and cancellation outcomes do not count: those require a
 * user or caller decision rather than another transport attempt.
 */

export type AdviserCircuitState = "healthy" | "degraded" | "open" | "half-open";

export interface AdviserHealthOptions {
  readonly failureThreshold?: number;
  readonly windowMs?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

export class AdviserCircuitOpenError extends Error {
  readonly code = "circuit_open" as const;

  constructor(readonly retryAfterMs: number) {
    super("ChatGPT adviser temporarily unavailable.");
    this.name = "AdviserCircuitOpenError";
  }
}

export interface AdviserHealthAdmission {
  readonly allowed: boolean;
  readonly state: AdviserCircuitState;
  readonly probe: boolean;
  readonly retryAfterMs?: number;
}

export class AdviserHealthCircuit {
  readonly #failureThreshold: number;
  readonly #windowMs: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  #failures: number[] = [];
  #state: AdviserCircuitState = "healthy";
  #openUntil = 0;
  #probeInFlight = false;

  constructor(options: AdviserHealthOptions = {}) {
    this.#failureThreshold = options.failureThreshold ?? 3;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  state(): AdviserCircuitState {
    this.#refresh();
    return this.#state;
  }

  admit(): AdviserHealthAdmission {
    this.#refresh();
    if (this.#state === "open") {
      return {
        allowed: false,
        state: "open",
        probe: false,
        retryAfterMs: Math.max(0, this.#openUntil - this.#now()),
      };
    }
    if (this.#state === "half-open") {
      if (this.#probeInFlight) return { allowed: false, state: "open", probe: false, retryAfterMs: this.#cooldownMs };
      this.#probeInFlight = true;
      return { allowed: true, state: "half-open", probe: true };
    }
    return { allowed: true, state: this.#state, probe: false };
  }

  /** Release a half-open probe that ended before transport health was proven. */
  releaseProbe(): void {
    this.#probeInFlight = false;
  }

  recordSuccess(): void {
    this.#failures = [];
    this.#openUntil = 0;
    this.#probeInFlight = false;
    this.#state = "healthy";
  }

  recordTransportFailure(): void {
    const now = this.#now();
    this.#prune(now);
    this.#failures.push(now);
    this.#probeInFlight = false;
    if (this.#failures.length >= this.#failureThreshold) {
      this.#state = "open";
      this.#openUntil = now + this.#cooldownMs;
    } else {
      this.#state = "degraded";
    }
  }

  #refresh(): void {
    const now = this.#now();
    this.#prune(now);
    if (this.#state === "open" && now >= this.#openUntil) {
      this.#state = "half-open";
      this.#probeInFlight = false;
    }
  }

  #prune(now: number): void {
    const floor = now - this.#windowMs;
    this.#failures = this.#failures.filter((at) => at > floor);
    if (this.#state === "degraded" && this.#failures.length === 0) this.#state = "healthy";
  }
}
