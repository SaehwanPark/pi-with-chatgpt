/**
 * Advisory versus required consultations (INV-07).
 *
 * The default is `advisory`: the adviser is a nice-to-have and its failure must degrade to local Pi
 * work. Blocking on the adviser is a decision the caller makes explicitly, per consultation, and it
 * is the only thing that turns an adviser failure into a stalled worker.
 */

export const DEPENDENCY_MODES = ["advisory", "required"] as const;

export type DependencyMode = (typeof DEPENDENCY_MODES)[number];

/** Changing this default changes the product contract; it is asserted by a test. */
export const DEFAULT_DEPENDENCY_MODE: DependencyMode = "advisory";

export function normalizeDependencyMode(value: string | undefined): DependencyMode {
  return DEPENDENCY_MODES.includes(value as DependencyMode) ? (value as DependencyMode) : DEFAULT_DEPENDENCY_MODE;
}

export type AdviserOutcome =
  | { readonly kind: "advice" }
  | {
      readonly kind: "adviser-failed";
      readonly mode: DependencyMode;
      /** What the worker should do next. `degrade-to-local` never stops the local task. */
      readonly disposition: Extract<AdviserFailureDisposition, "degrade-to-local">;
      readonly reason: AdviserFailureReason;
    }
  | {
      readonly kind: "blocked-on-adviser";
      readonly mode: Extract<DependencyMode, "required">;
      readonly disposition: Extract<AdviserFailureDisposition, "block-local-work">;
      readonly reason: AdviserFailureReason;
    };

export type AdviserFailureDisposition = "degrade-to-local" | "block-local-work";

export type AdviserFailureReason =
  | "not-authenticated"
  | "capability-unavailable"
  | "browser-runtime-failed"
  | "checkpoint-not-remote"
  | "rate-limited"
  | "timeout"
  | "malformed-response"
  | "cancelled";

export function dispositionFor(mode: DependencyMode): AdviserFailureDisposition {
  return mode === "required" ? "block-local-work" : "degrade-to-local";
}

export function adviserFailureOutcome(mode: DependencyMode, reason: AdviserFailureReason): AdviserOutcome {
  return dispositionFor(mode) === "block-local-work"
    ? { kind: "blocked-on-adviser", mode: "required", disposition: "block-local-work", reason }
    : { kind: "adviser-failed", mode: "advisory", disposition: "degrade-to-local", reason };
}
