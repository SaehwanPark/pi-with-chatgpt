import type { FullCommitSha } from "../protocol/sha.js";
import type { GitExecutor } from "./exec.js";

/**
 * Ancestry comparison between two commits — the evidence INV-04 uses to distinguish "not pushed
 * yet" from "the branch moved" from "unrelated histories" from "we could not tell".
 *
 * The `undefined` results are the point: a missing object, a shallow boundary, or a refused
 * invocation must not be reported as `false`. Reporting an unverifiable relation as a definite
 * answer is exactly how a consultation gets dispatched against a commit the adviser cannot open.
 */

export type CommitRelation =
  | "equal"
  /** `left` is an ancestor of `right` (the left side is behind). */
  | "left-ancestor-of-right"
  /** `right` is an ancestor of `left` (the left side is ahead). */
  | "right-ancestor-of-left"
  /** Both sides have commits the other lacks. */
  | "diverged"
  /** No merge base at all (unrelated histories). */
  | "unrelated";

export type AncestryObservations = {
  readonly identical: boolean;
  /** `merge-base --is-ancestor left right`, or `undefined` when git could not answer. */
  readonly leftIsAncestorOfRight: boolean | undefined;
  readonly rightIsAncestorOfLeft: boolean | undefined;
  /** Whether `merge-base left right` named a commit at all. */
  readonly hasMergeBase: boolean;
};

export type AheadBehind = {
  readonly ahead: number;
  readonly behind: number;
};

/**
 * `git merge-base --is-ancestor` exit codes: 0 = yes, 1 = no, 128 (or anything else) = cannot answer
 * — a missing object or a shallow-clone boundary both land here, and neither licenses a definite
 * answer.
 */
export function interpretIsAncestorExitCode(code: number): boolean | undefined {
  if (code === 0) return true;
  if (code === 1) return false;
  return undefined;
}

/** Pure classification of the observations, exported so the mapping is testable without git. */
export function classifyRelation(observations: AncestryObservations): CommitRelation | undefined {
  if (observations.identical) return "equal";
  // Either direction unanswered means the comparison did not happen; do not infer from the other one.
  if (observations.leftIsAncestorOfRight === undefined) return undefined;
  if (observations.rightIsAncestorOfLeft === undefined) return undefined;
  if (!observations.hasMergeBase) return "unrelated";

  const leftFirst = observations.leftIsAncestorOfRight;
  const rightFirst = observations.rightIsAncestorOfLeft;
  if (leftFirst && rightFirst) return "equal";
  if (leftFirst) return "left-ancestor-of-right";
  if (rightFirst) return "right-ancestor-of-left";
  return "diverged";
}

export async function compareCommits(
  git: GitExecutor,
  cwd: string,
  left: FullCommitSha,
  right: FullCommitSha,
): Promise<CommitRelation | undefined> {
  // Identical SHAs need no comparison at all, and skipping the spawn keeps "equal" definitionally
  // cheap rather than dependent on git's answer about an object that may not exist.
  if (left === right) return "equal";

  const leftToRight = await git.runAllowingFailure(
    ["merge-base", "--is-ancestor", left, right],
    cwd,
  );
  const rightToLeft = await git.runAllowingFailure(
    ["merge-base", "--is-ancestor", right, left],
    cwd,
  );
  const mergeBase = await git.runAllowingFailure(["merge-base", left, right], cwd);

  return classifyRelation({
    identical: false,
    leftIsAncestorOfRight: interpretIsAncestorExitCode(leftToRight.code),
    rightIsAncestorOfLeft: interpretIsAncestorExitCode(rightToLeft.code),
    hasMergeBase: mergeBase.code === 0 && mergeBase.stdout.trim() !== "",
  });
}

/**
 * `git rev-list --count --left-right <left>...<right>` prints `<behind>\t<ahead>` relative to
 * `<left>`. Getting the direction backwards sends the user the opposite advice ("push" when the
 * branch actually diverged), so the parse is a named, tested function.
 */
export function parseAheadBehindCounts(output: string): AheadBehind | undefined {
  const match = /^(\d+)\s+(\d+)$/.exec(output.trim());
  if (match === null) return undefined;
  return { ahead: Number(match[2]), behind: Number(match[1]) };
}

export async function aheadBehind(
  git: GitExecutor,
  cwd: string,
  left: FullCommitSha,
  right: FullCommitSha,
): Promise<AheadBehind | undefined> {
  const result = await git.runAllowingFailure(
    ["rev-list", "--count", "--left-right", `${left}...${right}`],
    cwd,
  );
  if (result.code !== 0) return undefined;
  return parseAheadBehindCounts(result.stdout);
}
