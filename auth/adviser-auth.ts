/**
 * The adviser authentication state machine (M2).
 *
 * One pure function decides what to do next from observed facts. Keeping it pure is what makes the
 * precedence rules reviewable — "Pi credential before browser session before capability before
 * identity" is the whole product contract of this milestone, and it must not be scattered across UI
 * callbacks where an out-of-order call could dispatch a consultation against an unverified profile.
 *
 * Two rules drive every branch:
 *   - never guess an account (an identity mismatch is a human decision, INV-10); and
 *   - never automate a human gate or retry its way past one (INV-09).
 */

import type { AccountIdentityHint, AccountMatch, AccountMismatchDecision } from "./identity.js";
import { resolveAccountIdentity } from "./identity.js";
import type { CapabilityRecord } from "../browser/capability.js";
import type { AdviserNextAction } from "../protocol/adviser.js";
import { requiresManualIntervention } from "../protocol/adviser.js";

export interface AdviserAuthFacts {
  /** Whether Pi holds an OpenAI credential at all. */
  readonly piCredentialPresent: boolean;
  /** An API key is transport, not an account: it cannot identify a ChatGPT plan or session. */
  readonly piCredentialIsApiKey: boolean;
  /**
   * The stored access token is past its expiry. Pi refreshes transparently, so this is *not* a
   * blocking state — but the identity hints read from a stale token are not trustworthy either.
   */
  readonly piCredentialExpired: boolean;
  /** Identity derived from the Pi credential; absent when it could not be determined. */
  readonly piIdentity?: AccountIdentityHint;
  /** The extension-owned profile directory exists. */
  readonly profilePresent: boolean;
  /** A probe has completed for this profile at least once. */
  readonly profileInitialized: boolean;
  /** A Chrome/Chromium profile with cookies is available to import (INV-11: never the user's browser). */
  readonly chromeImportAvailable: boolean;
  /** Latest capability probe, if any. */
  readonly capability?: CapabilityRecord;
  /** Identity observed in the adviser browser, if any. */
  readonly browserIdentity?: AccountIdentityHint;
  /**
   * The human decision after a mismatch. Absent means *no decision yet*, which blocks consultation;
   * there is deliberately no boolean "ignore mismatches" because it would outlive the moment it was
   * clicked and apply to the next mismatch too. It is bound to the account pair it was made for, so a
   * "keep current account" click cannot authorise a different account that appears later.
   */
  readonly mismatchDecision?: AccountMismatchDecision;
}

export type AdviserAuthState =
  | "pi-credential-missing"
  | "pi-credential-api-key"
  | "profile-missing"
  | "capability-unverified"
  | "sign-in-required"
  | "manual-intervention"
  | "rate-limited"
  | "plan-unsupported"
  | "environment-unavailable"
  | "account-mismatch"
  | "adviser-skipped"
  | "ready"
  | "ready-unverified-identity";

export interface AdviserAuthDecision extends Record<string, unknown> {
  readonly state: AdviserAuthState;
  readonly action: AdviserNextAction;
  readonly explanation: string;
  readonly requiresManualIntervention: boolean;
  readonly retryAfterSeconds?: number;
  /** Stated separately from `state` so a stale-token warning never blocks a consultation. */
  readonly warnings: readonly string[];
  /** Identity comparison result, when a comparison was possible. */
  readonly identityComparison?: AccountMatch;
}

/**
 * Resolve the next action.
 *
 * Order matters and is the contract: a valid Pi credential is required before any browser work, the
 * profile before any probe, a probe before any consultation, and an identity check last because it is
 * only meaningful once a session has been confirmed.
 */
export function resolveAdviserAuth(facts: AdviserAuthFacts): AdviserAuthDecision {
  const warnings: string[] = [];
  if (facts.piCredentialPresent && facts.piCredentialExpired) {
    warnings.push("Pi's stored access token is past its expiry; identity hints from it may be stale.");
  }

  if (!facts.piCredentialPresent) {
    return decide("pi-credential-missing", "run-pi-login", {
      explanation: "Pi has no OpenAI credential, so there is no account to advise through. Run Pi's OpenAI login.",
      warnings,
    });
  }
  if (facts.piCredentialIsApiKey) {
    return decide("pi-credential-api-key", "run-pi-login", {
      explanation:
        "Pi is authenticated with an API key. V1 advises through a ChatGPT web session tied to a Pi OpenAI sign-in, so an API key is not enough.",
      warnings,
    });
  }

  if (!facts.profilePresent) {
    return decide("profile-missing", "create-profile", {
      explanation: "The extension-owned adviser browser profile does not exist yet.",
      warnings,
    });
  }

  const capability = facts.capability;
  if (capability === undefined) {
    return decide("capability-unverified", "run-capability-probe", {
      explanation: facts.profileInitialized
        ? "The adviser profile exists but its ChatGPT capability has not been verified."
        : "No ChatGPT session has been established in the adviser profile yet; a verification run will confirm what is possible.",
      warnings,
    });
  }

  const fromCapability = decisionFromCapability(capability, facts, warnings);
  if (fromCapability !== undefined) return fromCapability;

  // Capability is ready: the only remaining question is *which account* is signed in. Every answer to
  // that question comes from `resolveAccountIdentity`, including "we cannot tell" — this module must
  // not hold a second copy of the rule, because the last time two modules each held one they
  // disagreed and the looser copy governed.
  const identity = resolveAccountIdentity({
    piAccount: facts.piIdentity,
    browserAccount: facts.browserIdentity,
    decision: facts.mismatchDecision,
  });
  // The comparison is reported by the decision rather than recomputed here. A second call would be a
  // second reading of the same rule, which is the shape that let the two copies disagree before.
  const comparison = identity.match;

  switch (identity.kind) {
    case "confirmed": {
      // A confirmed identity is either a demonstrated match or a mismatch the operator resolved by
      // keeping this account; the second is worth a standing warning because it changes which quota
      // and which project data the consultation touches.
      const matched = comparison === "match";
      return decide(matched ? "ready" : "ready-unverified-identity", "consult", {
        explanation: matched
          ? "Adviser ready."
          : "Adviser ready; the operator chose to keep this browser account.",
        warnings: matched
          ? warnings
          : [
              ...warnings,
              "Keeping the adviser browser account: this consultation is billed and scoped to that account, not to Pi's.",
            ],
        identityComparison: comparison,
      });
    }
    case "unverified":
      // Not a failure: a side could not be identified. "Cannot tell" is not "told, and they differ" —
      // a block that fires on every session teaches the operator to click through it, and the hint is
      // often legitimately absent (a plan with no account claim, a first run before the browser
      // account is read). It is still said out loud and never reported as a match.
      return decide("ready-unverified-identity", "consult", {
        explanation: "Adviser ready. Account identity could not be confirmed on both sides.",
        warnings: [...warnings, `Account identity unverified (${identity.reason}): Pi and the browser could not be matched.`],
        identityComparison: comparison,
      });
    case "skipped":
      return decide("adviser-skipped", "skip-adviser", {
        explanation: "The adviser is disabled for this session by request; work continues locally.",
        warnings,
        identityComparison: comparison,
      });
    case "awaiting-user":
      // `reauthenticate` also lands here: until a fresh sign-in has happened the mismatch stands, and
      // the right prompt is the interactive login rather than a generic review.
      return decide(
        "account-mismatch",
        facts.mismatchDecision?.choice === "reauthenticate" ? "manual-login" : "review-account-mismatch",
        {
          explanation:
            "The adviser browser is signed into a different ChatGPT account than Pi. Proceeding would consult another account's quota and see its project data.",
          warnings,
          identityComparison: comparison,
        },
      );
  }
}

function decisionFromCapability(
  capability: CapabilityRecord,
  facts: AdviserAuthFacts,
  warnings: readonly string[],
): AdviserAuthDecision | undefined {
  switch (capability.status) {
    case "ready":
      return undefined;
    case "sign-in-required":
      // Import first when a compatible Chrome profile exists: it is one confirmation instead of a
      // full interactive login. Never import from a running browser (the copy could be torn).
      return decide("sign-in-required", facts.chromeImportAvailable ? "import-chrome-state" : "manual-login", {
        explanation: facts.chromeImportAvailable
          ? "The adviser profile has no ChatGPT session, but a closed Chrome profile with cookies is available to import."
          : "The adviser profile has no ChatGPT session. Sign in once in the adviser window.",
        warnings,
      });
    case "manual-intervention-required":
      return decide("manual-intervention", "solve-verification", {
        explanation: capability.explanation,
        warnings,
      });
    case "rate-limited":
      return decide("rate-limited", "wait-for-rate-limit", {
        explanation: capability.explanation,
        warnings,
        ...(capability.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: capability.retryAfterSeconds }),
      });
    case "plan-unsupported":
      return decide("plan-unsupported", "stop-unsupported-plan", {
        explanation: capability.explanation,
        warnings,
      });
    case "environment-unavailable":
      return decide("environment-unavailable", "repair-environment", {
        explanation: capability.explanation,
        warnings,
      });
  }
}

function decide(
  state: AdviserAuthState,
  action: AdviserNextAction,
  detail: {
    readonly explanation: string;
    readonly warnings: readonly string[];
    readonly retryAfterSeconds?: number;
    readonly identityComparison?: AccountMatch;
  },
): AdviserAuthDecision {
  return {
    state,
    action,
    explanation: detail.explanation,
    requiresManualIntervention: requiresManualIntervention(action),
    ...(detail.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: detail.retryAfterSeconds }),
    ...(detail.identityComparison === undefined ? {} : { identityComparison: detail.identityComparison }),
    warnings: detail.warnings,
  };
}
