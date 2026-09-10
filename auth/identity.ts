/**
 * Account identity comparison without silent switching (INV-10).
 *
 * Pi's stored OpenAI/Codex identity and the ChatGPT browser session can point at different
 * accounts. "Pick whichever session works" is the dangerous fallback: it would move repository
 * context to an account the user did not choose. The types here make *hold and ask* the only
 * available outcome of a mismatch.
 *
 * This module is the **single authority** for that rule. An earlier revision split it across
 * `identity.ts` and `adviser-auth.ts`, which encoded "what happens when we cannot tell" twice with
 * opposite answers — and the copy that governed was the looser one, making the strict copy dead code.
 * Two definitions of one safety rule is the bug; the fix is that `resolveAccountIdentity` is the only
 * function any caller may use to turn observations into a decision, and it answers every case.
 */

import { createHash } from "node:crypto";

/** Where an identity observation came from. Sources are never merged into one identity. */
export type IdentitySource =
  /** Pi's own OpenAI/Codex OAuth credential, read through supported Pi abstractions. */
  | "pi-oauth"
  /** Optional secondary source, only consulted when Pi exposes nothing usable. */
  | "codex-cli"
  /** The isolated adviser browser profile's logged-in ChatGPT account. */
  | "chatgpt-browser"
  | "none";

/**
 * The namespace an {@link AccountIdentityHint.accountIdHint} belongs to.
 *
 * Identifiers only compare within their own namespace. Comparing a Chromium `gaia_id` (a Google
 * login) with Pi's `chatgpt_account_id` (a ChatGPT account) is not a comparison that ever returns
 * true, so doing it turns every real session into a permanent "mismatch" — and an alarm that always
 * sounds is an alarm that gets clicked through. Declaring the namespace makes the cross-namespace
 * case a question the code refuses to answer rather than one it answers wrongly.
 */
export type AccountIdNamespace =
  /** ChatGPT/OpenAI account id: Pi's stored `accountId`, or the browser's own account claim. */
  | "chatgpt-account"
  /** A Google account (Chromium `gaia_id`), which identifies a Google login, not a ChatGPT account. */
  | "google-gaia"
  /** A label or directory name. Never comparable with anything. */
  | "unqualified";

/**
 * A non-secret hint about an account. `planHint` is explicitly a hint: entitlements are decided by
 * a live capability check (M2), never by cached plan metadata, and never by comparing plan names.
 */
export interface AccountIdentityHint {
  readonly source: IdentitySource;
  /** Stable opaque identifier when available (for example a subject hash); never a token or cookie. */
  readonly accountIdHint?: string;
  /** Namespace of `accountIdHint`. Absent means the id cannot be compared, only shown. */
  readonly accountIdNamespace?: AccountIdNamespace;
  readonly emailMasked?: string;
  readonly planHint?: string;
}

export type AccountMatch = "match" | "mismatch" | "unknown";

/** Why a comparison could not be made. Reported to the operator instead of being called a match. */
export type IdentityUnverifiedReason =
  | "pi-identity-absent"
  | "browser-identity-absent"
  | "identifier-absent"
  | "namespace-absent"
  | "namespace-mismatch";

/** What the user may decide when the identities do not line up. There is no "auto" option. */
export type AccountMismatchChoice =
  /** Keep the current adviser account and accept its entitlements. */
  | "keep-current"
  /** Re-authenticate the isolated profile against the Pi account. */
  | "reauthenticate"
  /** Do not consult the adviser this session. */
  | "skip-adviser";

/**
 * A human decision about a mismatch, bound to the pair it was made for.
 *
 * An unscoped choice is a standing authorisation: clicking "keep this account" for work@example and
 * then signing the adviser profile into personal@example would consult the second account under the
 * first click's authority. The binding is a digest of the (Pi, browser) pair rather than the ids
 * themselves, so a choice object cannot leak an identifier into a log or the ledger by existing.
 */
export interface AccountMismatchDecision {
  readonly choice: AccountMismatchChoice;
  /** Opaque digest of the pair the human was shown; a decision for another pair has no effect. */
  readonly forAccountPair: string;
}

/**
 * The one decision a caller may act on.
 *
 * `unverified` and `awaiting-user` are deliberately different: the first says "nothing was
 * contradicted, and we say so out loud", the second says "something was contradicted and a human must
 * choose". Collapsing them is how a warning becomes either a permanent block or no block at all.
 *
 * Every variant carries the {@link AccountMatch} it was based on. A caller that recomputes the
 * comparison has begun holding its own copy of the rule, which is how the two copies came to disagree;
 * `confirmed` with `match: "mismatch"` means the operator chose to keep this browser account, and is
 * reported that way rather than quietly upgraded to a match.
 */
export type IdentityDecision =
  | { readonly kind: "confirmed"; readonly account: AccountIdentityHint; readonly match: AccountMatch }
  | { readonly kind: "unverified"; readonly reason: IdentityUnverifiedReason; readonly match: AccountMatch }
  | { readonly kind: "awaiting-user"; readonly match: Extract<AccountMatch, "mismatch"> }
  | { readonly kind: "skipped"; readonly reason: "user-declined"; readonly match: Extract<AccountMatch, "mismatch"> };

/**
 * Compare two identity hints.
 *
 * Anything short of two same-namespace identifiers is `unknown`: not "different", because that would
 * block on an absence of evidence, and not "same", because that would be a guess.
 */
export function compareAccountIdentity(
  piAccount: AccountIdentityHint,
  browserAccount: AccountIdentityHint,
): AccountMatch {
  if (unverifiedReason(piAccount, browserAccount) !== undefined) return "unknown";
  return piAccount.accountIdHint === browserAccount.accountIdHint ? "match" : "mismatch";
}

/** Why a comparison is impossible, or `undefined` when the two hints are comparable. */
export function unverifiedReason(
  piAccount: AccountIdentityHint | undefined,
  browserAccount: AccountIdentityHint | undefined,
): IdentityUnverifiedReason | undefined {
  if (piAccount === undefined) return "pi-identity-absent";
  if (browserAccount === undefined) return "browser-identity-absent";
  if (piAccount.source === "none" || browserAccount.source === "none") return "identifier-absent";
  if (piAccount.accountIdHint === undefined || browserAccount.accountIdHint === undefined) {
    return "identifier-absent";
  }
  if (piAccount.accountIdNamespace === undefined || browserAccount.accountIdNamespace === undefined) {
    return "namespace-absent";
  }
  if (piAccount.accountIdNamespace !== browserAccount.accountIdNamespace) return "namespace-mismatch";
  return undefined;
}

/**
 * Bind a human choice to the account pair it was made for.
 *
 * Takes the pair the UI actually displayed, so the binding cannot be asserted after the fact: to mint
 * a decision for a different pair, a caller would have to lie about what it showed.
 */
export function decideAccountMismatch(input: {
  readonly piAccount: AccountIdentityHint;
  readonly browserAccount: AccountIdentityHint;
  readonly choice: AccountMismatchChoice;
}): AccountMismatchDecision {
  return { choice: input.choice, forAccountPair: accountPairKey(input.piAccount, input.browserAccount) };
}

/** Opaque, stable digest of an account pair. Not an identifier; safe to keep in a session object. */
export function accountPairKey(
  piAccount: AccountIdentityHint | undefined,
  browserAccount: AccountIdentityHint | undefined,
): string {
  const describe = (hint: AccountIdentityHint | undefined): string =>
    hint === undefined
      ? "none"
      : [hint.source, hint.accountIdNamespace ?? "unqualified", hint.accountIdHint ?? "absent"].join(":");
  const material = `${describe(piAccount)}\u0000${describe(browserAccount)}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * The single authoritative resolution of "may this consultation proceed?".
 *
 * Answers every case, so a caller cannot get a rule by asking a different module:
 *   - no identifiers      → `unverified`, said out loud, consultation allowed;
 *   - matching ids        → `confirmed`;
 *   - differing ids       → `awaiting-user` until a human chooses *for this pair*;
 *   - a choice for a pair → applied only while the pair still matches.
 *
 * A `keep-current` for a pair that no longer matches is treated as no decision at all rather than as
 * a stale grant, which is the whole point of binding the two together.
 */
export function resolveAccountIdentity(input: {
  readonly piAccount?: AccountIdentityHint;
  readonly browserAccount?: AccountIdentityHint;
  readonly decision?: AccountMismatchDecision;
}): IdentityDecision {
  const reason = unverifiedReason(input.piAccount, input.browserAccount);
  if (reason !== undefined) {
    return { kind: "unverified", reason, match: "unknown" };
  }


  const piAccount = input.piAccount as AccountIdentityHint;
  const browserAccount = input.browserAccount as AccountIdentityHint;
  const match = compareAccountIdentity(piAccount, browserAccount);
  if (match === "unknown") {
    // Only reachable if `compareAccountIdentity` and `unverifiedReason` ever disagree about what is
    // comparable. Failing toward "unverified" rather than toward a proceed is the deliberate direction.
    return { kind: "unverified", reason: "identifier-absent", match };
  }
  if (match === "match") return { kind: "confirmed", account: browserAccount, match };

  const applies =
    input.decision !== undefined && input.decision.forAccountPair === accountPairKey(piAccount, browserAccount);
  switch (applies ? input.decision?.choice : undefined) {
    case "keep-current":
      return { kind: "confirmed", account: browserAccount, match };
    case "skip-adviser":
      return { kind: "skipped", reason: "user-declined", match };
    default:
      // Includes `reauthenticate`: until a fresh sign-in has happened the mismatch still stands.
      return { kind: "awaiting-user", match };
  }
}

