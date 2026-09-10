/**
 * Shared adviser-readiness vocabulary: the next action the operator should be offered.
 *
 * Lives in `protocol/` because three layers name the same actions with different knowledge —
 * `browser/capability.ts` knows what a probe observed, `auth/adviser-auth.ts` knows the whole
 * resolution state, and `ui/` renders whichever one acted. Duplicating the union in each place is how
 * a UI ends up offering an action nothing implements, so it is declared once here.
 */

export type AdviserNextAction =
  /** Ask the user to run Pi's own login; the OpenAI OAuth credential is the precondition for everything. */
  | "run-pi-login"
  | "create-profile"
  /** Copy the user's own Chromium cookies into the adviser profile. */
  | "import-chrome-state"
  | "manual-login"
  | "run-capability-probe"
  | "solve-verification"
  | "wait-for-rate-limit"
  | "stop-unsupported-plan"
  | "repair-environment"
  /** Identity mismatch: a human must choose before any consultation. */
  | "review-account-mismatch"
  /** The operator chose not to consult the adviser; nothing else is attempted. */
  | "skip-adviser"
  /** The intended adviser model is unavailable; picking an equivalent is a human decision. */
  | "choose-adviser-model"
  /** The GitHub connector is not usable from the ChatGPT account. */
  | "connect-github"
  /**
   * The checkpoint is not visible to the adviser. The extension never pushes on the user's behalf
   * (INV-05), so this is stated as a precondition the human satisfies.
   */
  | "publish-checkpoint"
  /** Everything is verified; a consultation may be dispatched. */
  | "consult";

export const ADVISER_NEXT_ACTIONS: readonly AdviserNextAction[] = [
  "run-pi-login",
  "create-profile",
  "import-chrome-state",
  "manual-login",
  "run-capability-probe",
  "solve-verification",
  "wait-for-rate-limit",
  "stop-unsupported-plan",
  "repair-environment",
  "review-account-mismatch",
  "skip-adviser",
  "choose-adviser-model",
  "connect-github",
  "publish-checkpoint",
  "consult",
];

/** Actions that must never be taken without a human in the loop (INV-09). */
export const MANUAL_INTERVENTION_ACTIONS: readonly AdviserNextAction[] = [
  "run-pi-login",
  "manual-login",
  // Import reads the user's real browser profile, so it is the most sensitive browser touch in the
  // product — strictly more so than opening an adviser window, which is already gated here. Leaving it
  // out would make the human-gated set internally inconsistent, and INV-11 is exactly "the user's
  // browser is never touched without the user".
  "import-chrome-state",
  "solve-verification",
  "stop-unsupported-plan",
  "repair-environment",
  "review-account-mismatch",
  "skip-adviser",
  "choose-adviser-model",
  "connect-github",
  "publish-checkpoint",
];

export function requiresManualIntervention(action: AdviserNextAction): boolean {
  return MANUAL_INTERVENTION_ACTIONS.includes(action);
}

/** One line for the status surface. Must be safe to log: no account identifiers, no paths. */
export interface AdviserReadiness {
  readonly action: AdviserNextAction;
  readonly explanation: string;
  /** True when no automatic retry can help (INV-09). */
  readonly requiresManualIntervention: boolean;
  readonly retryAfterSeconds?: number;
}
