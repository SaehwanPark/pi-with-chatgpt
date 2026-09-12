/**
 * `ui/policy.ts` — Semantic auto-consultation policy evaluation (INV-05, INV-07).
 *
 * Consultations must not be triggered blindly for trivial edits, raw line counts,
 * or simple retry loops. Only high-value semantic triggers or explicit settings qualify.
 */

import type { ConsultationKind } from "../protocol/brief.js";

export type AutoConsultPolicy = "off" | "high-value" | "always";

export interface SemanticTriggerContext {
  /** High-level description of what the user or worker is attempting. */
  readonly goal: string;
  /** Files modified or planned to be touched in this change. */
  readonly modifiedFiles?: readonly string[];
  /** Approximate lines changed. */
  readonly changedLoc?: number;
  /** Whether the change is an automated retry attempt. */
  readonly isRetry?: boolean;
  /** Consecutive retry count if applicable. */
  readonly failureCount?: number;
}

export interface PolicyEvaluationResult {
  readonly shouldConsult: boolean;
  readonly reason: string;
  readonly suggestedKind?: ConsultationKind;
}

const HIGH_VALUE_PATTERNS: ReadonlyArray<{ readonly regex: RegExp; readonly kind: ConsultationKind; readonly label: string }> = [
  { regex: /\b(architect(?:ure|ural)?|boundar(?:y|ies)|subsystem)\b/iu, kind: "challenge", label: "architectural shift" },
  { regex: /\b(migrat(?:e|ion|ing)?|schema|breaking change|deprecat(?:e|ion|ing)?|v\d+\s*->\s*v\d+)\b/iu, kind: "plan", label: "migration or schema change" },
  { regex: /\b(secur(?:e|ity)|vulnerab(?:le|ility)?|cve|credential|auth|permission|sandbox)\b/iu, kind: "audit", label: "security/auth change" },
  { regex: /\b(refactor(?:ing)?|redesign(?:ing)?|decouple|restructur(?:e|ing)?)\b/iu, kind: "plan", label: "major refactoring" },
  { regex: /\b(flak(?:y|iness)?|deadlock|race condition|memory leak|heapsnapshot)\b/iu, kind: "debug", label: "concurrency or leak investigation" },
  { regex: /\b(review|audit|cross-check)\b/iu, kind: "review", label: "explicit review request" },
];

const TRIVIAL_PATTERNS: readonly RegExp[] = [
  /\b(typo|fix spelling|formatting|lint|whitespace|comment)\b/iu,
  /\b(bump version|update lockfile|readme update)\b/iu,
];

export function evaluateAutoConsultation(
  context: SemanticTriggerContext,
  policy: AutoConsultPolicy = "high-value",
): PolicyEvaluationResult {
  if (policy === "off") {
    return { shouldConsult: false, reason: "auto-consultation policy is off" };
  }

  if (policy === "always") {
    return { shouldConsult: true, reason: "auto-consultation policy set to always", suggestedKind: "consult" };
  }

  // Trivial edit suppression: even if high LOC, trivial tasks are not consulted
  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(context.goal)) {
      return { shouldConsult: false, reason: "suppressed: goal indicates trivial or formatting edit" };
    }
  }

  // Retry-loop suppression: simple failure count alone is NOT a reason to consult
  if (context.isRetry && (context.failureCount ?? 0) <= 2 && !HIGH_VALUE_PATTERNS.some((p) => p.regex.test(context.goal))) {
    return { shouldConsult: false, reason: "suppressed: retry count alone does not meet semantic trigger threshold" };
  }

  // Check semantic high-value triggers
  for (const trigger of HIGH_VALUE_PATTERNS) {
    if (trigger.regex.test(context.goal)) {
      return {
        shouldConsult: true,
        reason: `triggered by semantic match: ${trigger.label}`,
        suggestedKind: trigger.kind,
      };
    }
  }

  // Multi-module boundary touch trigger
  if (context.modifiedFiles && context.modifiedFiles.length > 0) {
    const rootModules = new Set(
      context.modifiedFiles
        .map((f) => f.replace(/^\.\//u, "").split("/")[0])
        .filter((mod): mod is string => mod !== undefined && mod.length > 0),
    );
    if (rootModules.size >= 3) {
      return {
        shouldConsult: true,
        reason: `triggered: change spans multiple module roots (${Array.from(rootModules).join(", ")})`,
        suggestedKind: "plan",
      };
    }
  }

  return {
    shouldConsult: false,
    reason: "no high-value semantic trigger matched",
  };
}
