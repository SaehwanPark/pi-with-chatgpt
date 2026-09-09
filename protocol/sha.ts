/**
 * Immutable commit anchor primitives (INV-03).
 *
 * The consultation coordinate system is a *full* commit SHA that exists on the GitHub remote.
 * Abbreviated SHAs, branch names, `HEAD`, and tags are all mutable or ambiguous, so they are not
 * representable as an anchor: the only way to obtain a `FullCommitSha` is to parse one.
 */

const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Branded so that a plain `string` (for example a branch name) cannot be passed as an anchor. */
export type FullCommitSha = string & { readonly __brand: "FullCommitSha" };

export type CommitRefRejection =
  /** Empty or whitespace-only input. */
  | "empty"
  /** 7–39 hex characters: ambiguous because the object database may hold several matches. */
  | "abbreviated"
  /** 40 hex characters that are not lowercase: valid git spelling, but not the canonical form we persist and compare. */
  | "non-canonical-case"
  /** 64 hex characters: a SHA-256 object ID, which V1 anchors do not support. */
  | "sha256-not-supported"
  /** Not hex at all — typically a branch, tag, or `HEAD`. */
  | "not-hex";

export interface CommitRefRejectionDetail {
  readonly reason: CommitRefRejection;
  readonly input: string;
}

/** Returns the reason `value` cannot anchor a consultation, or `undefined` when it can. */
export function classifyCommitRef(value: string): CommitRefRejectionDetail | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { reason: "empty", input: value };
  if (FULL_COMMIT_SHA_PATTERN.test(trimmed)) return undefined;
  if (/^[0-9a-f]{64}$/.test(trimmed)) return { reason: "sha256-not-supported", input: value };
  if (/^[0-9A-F]{40}$/.test(trimmed)) return { reason: "non-canonical-case", input: value };
  if (/^[0-9a-f]{7,39}$/i.test(trimmed)) return { reason: "abbreviated", input: value };
  return { reason: "not-hex", input: value };
}

export function isFullCommitSha(value: string): value is FullCommitSha {
  return FULL_COMMIT_SHA_PATTERN.test(value.trim());
}

export function parseFullCommitSha(value: string): FullCommitSha | undefined {
  const trimmed = value.trim();
  return FULL_COMMIT_SHA_PATTERN.test(trimmed) ? (trimmed as FullCommitSha) : undefined;
}

/** Thrown when a ref that cannot anchor a consultation is used as one. */
export class InvalidCommitAnchorError extends Error {
  readonly rejection: CommitRefRejection;
  readonly rejectedInput: string;

  constructor(detail: CommitRefRejectionDetail) {
    super(
      `"${detail.input}" cannot anchor a consultation (${detail.reason}); a 40-character lowercase commit SHA is required`,
    );
    this.name = "InvalidCommitAnchorError";
    this.rejection = detail.reason;
    this.rejectedInput = detail.input;
  }
}

export function requireFullCommitSha(value: string): FullCommitSha {
  const rejection = classifyCommitRef(value);
  if (rejection !== undefined) throw new InvalidCommitAnchorError(rejection);
  // Safe: classifyCommitRef only returns undefined for a trimmed, lowercase, 40-hex string.
  return value.trim() as FullCommitSha;
}
