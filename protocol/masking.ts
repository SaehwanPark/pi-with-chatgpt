/**
 * Display masking for personal data and account identifiers (INV-12).
 *
 * Lives in `protocol/` because the modules that observe an account are spread across the tree —
 * `auth/` reads Pi's credential, `browser/` reads Chromium's `Local State`, `ui/` renders a status
 * line — and a rule that is re-implemented per module is a rule that drifts until one of them forgets
 * to mask. They all import this instead.
 *
 * These are display helpers, not identity comparisons. A masked value is for a human recognising
 * "that is my work account"; it must never be used to decide whether two accounts are the same, which
 * is why {@link compareAccountIdentity} in `auth/identity.ts` refuses to look at masked fields.
 */

/** How much of an opaque identifier to keep. Long enough to recognise, too short to reuse. */
const OPAQUE_ID_PREFIX_LENGTH = 6;

/**
 * Mask an email for display: keep the first character and the domain, hide the local part.
 *
 * Full addresses are personal data and this project's rule for personal data is that it does not go
 * into logs, ledgers, or model context. The mask still answers "is this the account I think it is?".
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Shorten an opaque identifier (a GAIA id, a ChatGPT account id) so it can be shown, not replayed.
 *
 * Prefix-only rather than prefix-and-suffix: an id whose ends are both visible is close to a full id,
 * and these values are stable across a person's accounts in ways email local parts are not.
 */
export function maskOpaqueId(id: string): string {
  if (id.length <= OPAQUE_ID_PREFIX_LENGTH) return "***";
  return `${id.slice(0, OPAQUE_ID_PREFIX_LENGTH)}…`;
}

/** Keys that must never appear in a ledger record, brief, or state file at any depth (INV-12). */
export const SENSITIVE_KEY_PATTERN =
  /(cookie|authorization|token|secret|password|passwd|credential|apikey|api_key|sessionid|session_id|bearer|oauth|accesskey|privatekey|userdata|user_data|profilepath|profile_path)/iu;

/** Value shapes that indicate a credential leaked into prose or state (INV-12). */
export const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bsk-[A-Za-z0-9_-]{16,}/u,
  /set-cookie\s*:/iu,
  /cookie\s*:[^\n]{8,}/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

/** Scans a value or object graph for credential patterns. */
export function containsSensitiveData(value: unknown): boolean {
  if (typeof value === "string") {
    return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveData(entry));
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) return true;
      if (containsSensitiveData(entry)) return true;
    }
  }
  return false;
}

/**
 * Remove credential-shaped substrings from adviser prose while preserving the surrounding answer.
 *
 * Adviser output can quote a fake token from a repository test or security document. Rejecting the
 * entire response loses useful, otherwise valid advice; persisting the token-shaped text is unsafe.
 * This helper is intentionally string-only and uses the same patterns as `containsSensitiveData`, so
 * callers can redact the response before parsing or writing it and then assert that the result is safe.
 */
export function redactSensitiveText(value: string): { readonly text: string; readonly redacted: boolean } {
  let text = value;
  let redacted = false;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    text = text.replace(pattern, () => {
      redacted = true;
      return "[redacted-sensitive-data]";
    });
  }
  return { text, redacted };
}
