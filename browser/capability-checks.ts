/**
 * Pre-consultation capability checklist and cache policy (M2).
 *
 * "Is ChatGPT reachable" is not the question a consultation asks; the question is "can this account,
 * with this model, on this repository, right now". Those are four independent facts, each of which can
 * be *verified*, *unavailable*, or *unverified* — and the third is not the second. Collapsing
 * "we did not look" into "it is broken" produces confident false failures, while collapsing it into
 * "it works" dispatches consultations into avoidable errors.
 *
 * The observations themselves come from the browser runtime (M3). This module decides what they mean.
 */

import type { CapabilityRecord, CapabilityStatus } from "./capability.js";
import { requiresManualIntervention } from "../protocol/adviser.js";

export type VerificationItem = "chatgpt-access" | "adviser-model" | "github-connector" | "target-repository";

/** Four states on purpose: a check that has not run yet is not a failed check. */
export type VerificationOutcome = "verified" | "unavailable" | "unverified" | "not-applicable";

export interface VerificationResult {
  readonly item: VerificationItem;
  readonly outcome: VerificationOutcome;
  /** Safe, stable, human-readable detail. No page content, no identifiers. */
  readonly detail?: string;
}

export interface CapabilityChecklist {
  readonly results: readonly VerificationResult[];
  /** ISO time of the checks, used only for cache freshness. */
  readonly checkedAt: string;
}

/** Items that must be verified before a consultation may be dispatched. */
export const REQUIRED_BEFORE_FIRST_CONSULTATION: readonly VerificationItem[] = [
  "chatgpt-access",
  "adviser-model",
  "target-repository",
];

export type PrerequisiteEvaluation =
  | { readonly ok: true; readonly verified: readonly VerificationItem[] }
  | {
      readonly ok: false;
      /** Items that failed or were never checked, in the order a human should address them. */
      readonly blocking: readonly {
        readonly item: VerificationItem;
        readonly outcome: Exclude<VerificationOutcome, "verified" | "not-applicable">;
      }[];
    };

/**
 * Decide whether a consultation may be dispatched.
 *
 * `unverified` blocks alongside `unavailable` but is reported separately: the remedy for the first is
 * to run the check, the remedy for the second is to fix the account or the repository.
 */
export function evaluateConsultationPrerequisites(
  checklist: CapabilityChecklist,
  required: readonly VerificationItem[] = REQUIRED_BEFORE_FIRST_CONSULTATION,
): PrerequisiteEvaluation {
  const blocking = required
    .map((item) => ({ item, result: checklist.results.find((candidate) => candidate.item === item) }))
    .filter((entry) => entry.result === undefined || !isPassing(entry.result.outcome))
    .map((entry) => ({
      item: entry.item,
      outcome: (entry.result?.outcome ?? "unverified") as "unavailable" | "unverified",
    }));
  return blocking.length === 0
    ? { ok: true, verified: required.filter((item) => isPassing(checklist.results.find((r) => r.item === item)?.outcome)) }
    : { ok: false, blocking };
}

/** A connector that is merely unverified does not block a consultation; it degrades what the adviser can see. */
function isPassing(outcome: VerificationOutcome | undefined): boolean {
  return outcome === "verified" || outcome === "not-applicable";
}

/**
 * Choose the adviser model.
 *
 * The requested model is used when it is actually present. Otherwise the highest-ranked alternative
 * is reported as a *degraded* selection so the caller can say so out loud; a model never offered by the
 * provider is never invented, and an empty list is an explicit failure rather than a silent guess.
 */
export function selectAdviserModel(
  requestedModel: string,
  availableModels: readonly string[],
  preferenceOrder: readonly string[] = availableModels,
): { readonly model: string; readonly degraded: boolean } | { readonly model: undefined; readonly degraded: true } {
  if (availableModels.length === 0) return { model: undefined, degraded: true };
  if (availableModels.includes(requestedModel)) return { model: requestedModel, degraded: false };
  const ranked = preferenceOrder.filter((model) => availableModels.includes(model));
  if (ranked.length === 0) return { model: undefined, degraded: true };
  return { model: ranked[0] as string, degraded: true };
}

/**
 * Cache lifetimes, deliberately short and status-dependent.
 *
 * A positive result is the one worth caching (it is also the one most likely to go stale silently, so
 * the window is hours, not days). Negative results expire fast because the user is expected to act on
 * them, and a rate limit expires when the provider said it would.
 */
export const CAPABILITY_CACHE_TTL_MS: Record<CapabilityStatus, number> = {
  ready: 6 * 60 * 60 * 1000,
  "sign-in-required": 5 * 60 * 1000,
  "manual-intervention-required": 60 * 1000,
  "plan-unsupported": 24 * 60 * 60 * 1000,
  "rate-limited": 60 * 1000,
  "environment-unavailable": 5 * 60 * 1000,
};

/** Events that invalidate any cached result regardless of age. */
export type CapabilityInvalidatingEvent =
  | "sign-in-completed"
  | "chrome-state-imported"
  | "profile-recreated"
  | "authentication-failed"
  | "provider-model-list-changed"
  | "repository-visibility-changed";

/**
 * Whether the cached record may still be used.
 *
 * An explicit revalidation event always wins over the clock: the failure mode this prevents is a
 * six-hour-old "ready" surviving a sign-out or an import, and telling the user the adviser is fine
 * while it is not.
 */
export function capabilityCacheIsValid(
  record: CapabilityRecord,
  options: {
    readonly now: string;
    readonly event?: CapabilityInvalidatingEvent;
    readonly ttlMs?: number;
  },
): boolean {
  if (options.event !== undefined) return false;
  const ttl = options.ttlMs ?? CAPABILITY_CACHE_TTL_MS[record.status];
  const age = Date.parse(options.now) - Date.parse(record.checkedAt);
  if (!Number.isFinite(age)) return false;
  if (age < 0) return false;
  if (record.retryAfterSeconds !== undefined) {
    // "Retry after N seconds" is an instruction to re-probe, not a cache lifetime: keeping a
    // rate-limited verdict alive would keep reporting a limit that may already have lifted.
    return false;
  }
  return age < ttl;
}

/** Merge a checklist into the record a status surface shows, keeping the strictest verdict. */
export function checklistToCapabilityRecord(
  checklist: CapabilityChecklist,
  evaluation: PrerequisiteEvaluation,
): CapabilityRecord {
  if (evaluation.ok) {
    return {
      status: "ready",
      checkedAt: checklist.checkedAt,
      explanation: "ChatGPT access, adviser model, and checkpoint visibility are verified.",
      requiresManualIntervention: false,
      nextAction: "consult",
    };
  }
  const first = evaluation.blocking[0];
  const blockingItem = first?.item ?? "chatgpt-access";
  const outcome = first?.outcome ?? "unverified";
  const status = statusFor(blockingItem, outcome);
  const action = actionFor(blockingItem, outcome);
  return {
    status,
    checkedAt: checklist.checkedAt,
    explanation: explain(blockingItem, outcome),
    requiresManualIntervention: requiresManualIntervention(action),
    nextAction: action,
    reason: `${blockingItem}:${outcome}`,
  };
}

function statusFor(item: VerificationItem, outcome: "unavailable" | "unverified"): CapabilityStatus {
  if (item === "chatgpt-access") return outcome === "unavailable" ? "environment-unavailable" : "sign-in-required";
  if (item === "target-repository") return "environment-unavailable";
  return outcome === "unavailable" ? "environment-unavailable" : "sign-in-required";
}

function actionFor(item: VerificationItem, outcome: "unavailable" | "unverified") {
  switch (item) {
    case "chatgpt-access":
      return outcome === "unavailable" ? "repair-environment" : "manual-login";
    case "adviser-model":
      return "choose-adviser-model";
    case "target-repository":
      return "publish-checkpoint";
    case "github-connector":
      return "connect-github";
  }
}

function explain(item: VerificationItem, outcome: "unavailable" | "unverified"): string {
  const subject = {
    "chatgpt-access": "ChatGPT access",
    "adviser-model": "the adviser model",
    "github-connector": "the GitHub connector",
    "target-repository": "checkpoint visibility on GitHub",
  }[item];
  return outcome === "unverified"
    ? `${subject} has not been verified yet; run the check before consulting.`
    : `${subject} is unavailable for this account.`;
}
