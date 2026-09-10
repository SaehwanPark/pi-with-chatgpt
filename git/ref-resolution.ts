import { isFullCommitSha, type FullCommitSha } from "../protocol/sha.js";
import type { GitExecutor } from "./exec.js";

/**
 * Checkpoint resolution: `requestedRef` → `resolvedCommit`.
 *
 * INV-03 requires both halves, so resolution returns both and never collapses them. Resolution is
 * performed against the local object database only; proving the result exists on the remote is a
 * separate probe (`remote-availability.ts`), because "git knows this commit" and "the adviser can
 * read this commit" are different claims.
 */

export type RefResolutionRejectionReason =
  | "empty-ref"
  | "ref-looks-like-a-flag"
  | "ref-contains-control-characters"
  | "ref-too-long"
  | "unresolvable-ref"
  | "resolved-to-non-commit";

export type RefResolution = {
  readonly requestedRef: string;
  readonly resolvedCommit: FullCommitSha;
};

export type RefRejection = {
  readonly requestedRef: string;
  readonly reason: RefResolutionRejectionReason;
  /** Why the ref was refused, in a sentence safe to show a worker. */
  readonly explanation: string;
};

export type RefResolutionResult =
  | { readonly ok: true; readonly resolution: RefResolution }
  | { readonly ok: false; readonly rejection: RefRejection };

/**
 * Upper bound for a ref name: git's own limit is far higher, and anything this long is an injected
 * blob rather than a ref.
 */
export const MAX_REF_LENGTH = 1024;

/**
 * Structural ref validation, before git sees the value.
 *
 * These are not style rules: an argument beginning with `-` is interpreted by git as an option, and
 * control characters are how a "ref" smuggles a second command or a log-forging newline. Refusing
 * structurally means the read-only allowlist never has to reason about adversarial ref text.
 */
export function validateRefShape(rawRef: string): RefRejection | undefined {
  const ref = rawRef.trim();
  if (ref === "") return reject(rawRef, "empty-ref", "A checkpoint ref must not be empty.");
  if (ref.startsWith("-")) {
    return reject(
      rawRef,
      "ref-looks-like-a-flag",
      "A checkpoint ref must not begin with '-' (git would read it as an option).",
    );
  }
  if (/[`\r\n\0\t]/.test(ref)) {
    return reject(
      rawRef,
      "ref-contains-control-characters",
      "A checkpoint ref must not contain newlines, tabs, NUL, or backticks.",
    );
  }
  if (ref.length > MAX_REF_LENGTH) {
    return reject(
      rawRef,
      "ref-too-long",
      `A checkpoint ref must be at most ${MAX_REF_LENGTH} characters.`,
    );
  }
  return undefined;
}

function reject(
  requestedRef: string,
  reason: RefResolutionRejectionReason,
  explanation: string,
): RefRejection {
  return { requestedRef, reason, explanation };
}

/**
 * Resolve a ref to a full commit SHA.
 *
 * `^{commit}` peels tags (and other annotated objects) to the commit they point at, so a tag anchor
 * is still a commit anchor. `--quiet --verify` makes "no such ref" an empty result rather than an
 * exception, which keeps the refusal structured.
 */
export async function resolveCheckpointRef(
  git: GitExecutor,
  cwd: string,
  requestedRef: string,
): Promise<RefResolutionResult> {
  const shapeRejection = validateRefShape(requestedRef);
  if (shapeRejection !== undefined) return { ok: false, rejection: shapeRejection };

  const ref = requestedRef.trim();
  const probe = await git.runAllowingFailure(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    cwd,
  );
  const output = probe.stdout.trim();

  if (probe.code !== 0 || output === "") {
    return {
      ok: false,
      rejection: reject(
        requestedRef,
        "unresolvable-ref",
        `"${ref}" does not resolve to a commit in this repository.`,
      ),
    };
  }
  if (!isFullCommitSha(output)) {
    // A non-SHA answer means the peeled object is not a commit (or git spelled something unexpected).
    return {
      ok: false,
      rejection: reject(
        requestedRef,
        "resolved-to-non-commit",
        `"${ref}" does not resolve to a commit object.`,
      ),
    };
  }

  return { ok: true, resolution: { requestedRef: ref, resolvedCommit: output } };
}
