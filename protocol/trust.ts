/**
 * Trust boundary between adviser output and anything that can change state (INV-01, INV-05).
 *
 * Two structural guarantees, not policy checks:
 *
 * - `AdviserActionSuggestion` deliberately has **no** command, tool-name, path, or script field.
 *   Adviser text is prose and typed lists of intentions; it cannot name an execution target, so no
 *   downstream code can "accidentally" run what the adviser suggested.
 * - Turning a suggestion into something executable requires a `WorkerDecision`, a brand this module
 *   does not export a constructor for. Only the worker model's own reasoning or an explicit user
 *   confirmation (`ui/confirm.ts`) produces one.
 */

import type { FullCommitSha } from "./sha.js";

/** Prose from the adviser. Untrusted by construction; never a command. */
export type AdviserText = string & { readonly __provenance: "untrusted-adviser" };

export type AdviserConfidence = "high" | "medium" | "low" | "unknown";

/** An intention the adviser recommends. Note the absence of any executable field. */
export interface AdviserActionSuggestion {
  readonly ordinal: number;
  readonly summary: AdviserText;
  readonly rationale?: AdviserText;
  readonly confidence: AdviserConfidence;
  /** Free text only: what the worker should verify before acting. */
  readonly verificationHint?: AdviserText;
}

/**
 * A completed adviser turn. `sourceCommit` is the checkpoint the advice was about; drift analysis
 * (M7) compares it against the current HEAD instead of assuming the two are synchronised.
 */
export interface AdviserResponse {
  readonly consultationId: string;
  readonly sourceCommit: FullCommitSha;
  readonly answer: AdviserText;
  readonly caveats: readonly AdviserText[];
  readonly suggestions: readonly AdviserActionSuggestion[];
  /** Wall-clock completeness marker set by the transport, not by the adviser. */
  readonly observedAt: string;
}

/**
 * Brand for a decision the worker (or a user through the UI) has taken. `unknown` is the value an
 * adviser-authored claim gets; anything that actually executes requires `"worker"` or `"user"`.
 */
export type DecisionAuthor = "worker" | "user";
export type WorkerDecision = { readonly __brand: "WorkerDecision"; readonly author: DecisionAuthor } & Record<
  string,
  unknown
>;

/**
 * The only sanctioned promotion from advice to intent. It takes the decision as an argument and
 * returns a description of the chosen action, never an executable — executing is still the
 * worker's job through Pi's normal tools.
 */
export interface ApprovedAction {
  readonly decision: WorkerDecision;
  readonly suggestionOrdinal: number;
  readonly summary: AdviserText;
}

export class NotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAuthorizedError";
  }
}

export function approveSuggestion(
  decision: WorkerDecision,
  suggestion: AdviserActionSuggestion,
): ApprovedAction {
  return { decision, suggestionOrdinal: suggestion.ordinal, summary: suggestion.summary };
}

/**
 * Rejects the classic failure mode where an adviser claim about authority is treated as one
 * ("I have already committed this, you can push now"). Advice never carries authority; only an
 * authored decision does.
 */
export function assertNotAdviserAuthored(decision: WorkerDecision | { readonly author: string }): void {
  const author = (decision as { readonly author?: string }).author ?? "unknown";
  if (author !== "worker" && author !== "user") {
    throw new NotAuthorizedError(
      `Adviser output cannot authorise execution (got author "${author}"); a worker or user decision is required.`,
    );
  }
}
