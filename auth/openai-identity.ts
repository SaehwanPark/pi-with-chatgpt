import { maskEmail } from "../protocol/masking.js";
import type { AccountIdentityHint } from "./identity.js";
import type { SecretText } from "./secret-text.js";

/**
 * Account identity derived from material we already hold, with nothing secret in the output.
 *
 * Two rules make this safe to thread through status lines, ledger records, and (indirectly) the
 * worker-facing surface:
 *
 * 1. **Identifiers, not proof.** The ChatGPT account id is an opaque uuid; an email is masked to a
 *    shape nobody can phish or reuse. Nothing here is a credential.
 * 2. **Hints stay hints.** Plan type comes from an unverified token claim and is typed as
 *    {@link AccountIdentityHint.planHint}, which no capability check is allowed to consume. The live
 *    check ("is the strong adviser model actually selectable?") is the only entitlement verdict.
 */

/**
 * Claim namespaces OpenAI uses for ChatGPT account attributes in Codex access tokens.
 *
 * The claims are nested objects keyed by the namespace URL — `claims["https://api.openai.com/auth"]
 * .chatgpt_plan_type` — which is easy to get wrong because the serialised name looks like a flat
 * dotted key when printed. Both spellings are accepted; see {@link namespaceClaim}.
 */
const AUTH_CLAIM_NAMESPACE = "https://api.openai.com/auth";
const PROFILE_CLAIM_NAMESPACE = "https://api.openai.com/profile";

/** Identity read from Pi's OpenAI/Codex credential, plus the freshness of the underlying token. */
export type PiOpenAiIdentity = AccountIdentityHint & {
  /** Epoch milliseconds when the access token stops being usable. */
  readonly expiresAt: number;
  /** Convenience derived from `expiresAt` and the caller-supplied clock. */
  readonly expired: boolean;
};

/**
 * Read identity claims out of an access token *without* verifying it.
 *
 * That is sound only because of what the result is used for: an opaque account id for *comparison*,
 * and labels that are explicitly hints. Nothing here authorises a request — the token itself does
 * that, at the transport, and a forged local token would buy an attacker nothing they do not already
 * have by writing the file. Verification would require keys and a trust story this module does not
 * need, so it is deliberately absent rather than accidentally omitted.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  const payload = segments[1];
  if (payload === undefined || payload.length === 0) return undefined;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the Pi-side identity hint.
 *
 * The stored `accountId` wins over the token claim: it is what Pi itself treats as the account, and
 * reading it avoids needing the token at all for the common case. Claims are consulted only for the
 * optional plan/email hints, and a token that does not parse degrades to "identity without hints"
 * rather than to an error — an unreadable JWT is not a reason the adviser cannot be used.
 */
export function piOpenAiIdentity(
  credential: {
    readonly kind: "oauth";
    readonly accessToken: SecretText;
    readonly expiresAt: number;
    readonly accountId?: string;
  },
  now: number = Date.now(),
): PiOpenAiIdentity {
  const claims = decodeJwtClaims(credential.accessToken.expose());
  const auth = namespaceClaims(claims, AUTH_CLAIM_NAMESPACE);
  const profile = namespaceClaims(claims, PROFILE_CLAIM_NAMESPACE);
  const accountId =
    credential.accountId ??
    (stringClaim(auth, "chatgpt_account_id") ?? stringClaim(claims, "chatgpt_account_id")) ??
    undefined;
  const email = stringClaim(profile, "email");
  const plan = stringClaim(auth, "chatgpt_plan_type");

  return {
    source: "pi-oauth",
    ...(accountId !== undefined ? { accountIdHint: accountId, accountIdNamespace: "chatgpt-account" } : {}),
    ...(email !== undefined ? { emailMasked: maskEmail(email) } : {}),
    ...(plan !== undefined ? { planHint: plan } : {}),
    expiresAt: credential.expiresAt,
    expired: credential.expiresAt <= now,
  };
}

/** Identity for a stored API key: a transport credential with no ChatGPT account attached to it. */
export function piApiKeyIdentity(): AccountIdentityHint {
  // Deliberately empty of identifiers. Reporting `source: "pi-oauth"` here would let an account
  // comparison treat an API key as an account and "match" it against a logged-in browser session.
  return { source: "none" };
}

// `maskEmail` moved to `protocol/masking.ts` so `browser/` can use the same rule without importing
// `auth/` (which would invert the auth → browser dependency). Re-exported here because this is still
// where a reader looks for "how does a Pi identity get displayed".
export { maskEmail };

/** Whether a plan label looks like a paid tier. Hint only; never an entitlement decision. */
export function planHintSuggestsPaid(planHint: string | undefined): boolean | undefined {
  if (planHint === undefined) return undefined;
  const normalized = planHint.trim().toLowerCase();
  if (normalized === "") return undefined;
  const free = new Set(["free", "guest", "anonymous", "trial"]);
  return !free.has(normalized);
}

function stringClaim(claims: Record<string, unknown> | undefined, key: string): string | undefined {
  if (claims === undefined) return undefined;
  const value = claims[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One nested claim namespace, or undefined when the token does not carry it. */
function namespaceClaims(
  claims: Record<string, unknown> | undefined,
  namespace: string,
): Record<string, unknown> | undefined {
  if (claims === undefined) return undefined;
  const value = claims[namespace];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
