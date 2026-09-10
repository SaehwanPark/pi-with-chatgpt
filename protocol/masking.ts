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
