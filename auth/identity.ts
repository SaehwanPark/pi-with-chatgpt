/**
 * Account identity comparison without silent switching (INV-10).
 *
 * Pi's stored OpenAI/Codex identity and the ChatGPT browser session can point at different
 * accounts. "Pick whichever session works" is the dangerous fallback: it would move repository
 * context to an account the user did not choose. The types here make *hold and ask* the only
 * available outcome of a mismatch.
 */

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
 * A non-secret hint about an account. `planHint` is explicitly a hint: entitlements are decided by
 * a live capability check (M2), never by cached plan metadata, and never by comparing plan names.
 */
export interface AccountIdentityHint {
  readonly source: IdentitySource;
  /** Stable opaque identifier when available (for example a subject hash); never a token or cookie. */
  readonly accountIdHint?: string;
  readonly emailMasked?: string;
  readonly planHint?: string;
}

export type AccountMatch = "match" | "mismatch" | "unknown";

/** What the user may decide when the identities do not line up. There is no "auto" option. */
export type AccountMismatchChoice =
  /** Keep the current adviser account and accept its entitlements. */
  | "keep-current"
  /** Re-authenticate the isolated profile against the Pi account. */
  | "reauthenticate"
  /** Do not consult the adviser this session. */
  | "skip-adviser";

export type AccountResolution =
  | { readonly kind: "proceed"; readonly account: AccountIdentityHint }
  | { readonly kind: "awaiting-user"; readonly match: Extract<AccountMatch, "mismatch" | "unknown"> }
  | { readonly kind: "skipped"; readonly reason: "user-declined" };

export function compareAccountIdentity(
  piAccount: AccountIdentityHint,
  browserAccount: AccountIdentityHint,
): AccountMatch {
  if (piAccount.accountIdHint === undefined || browserAccount.accountIdHint === undefined) return "unknown";
  if (piAccount.source === "none" || browserAccount.source === "none") return "unknown";
  return piAccount.accountIdHint === browserAccount.accountIdHint ? "match" : "mismatch";
}

/**
 * Resolve a mismatch. With no explicit choice the result is `awaiting-user`: this function cannot
 * fall through to "use the other account", which is the whole invariant.
 */
export function resolveAccountMismatch(
  account: AccountIdentityHint,
  match: AccountMatch,
  choice?: AccountMismatchChoice,
): AccountResolution {
  if (match === "match") return { kind: "proceed", account };
  if (choice === undefined) return { kind: "awaiting-user", match };
  switch (choice) {
    case "keep-current":
      return { kind: "proceed", account };
    case "reauthenticate":
      return { kind: "awaiting-user", match: "mismatch" };
    case "skip-adviser":
      return { kind: "skipped", reason: "user-declined" };
  }
}
