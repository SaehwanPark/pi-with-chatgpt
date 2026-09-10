import type { PullRequestRef } from "../protocol/checkpoint.js";
import type { GitHubRepositoryKey } from "../protocol/repo.js";
import type { FullCommitSha } from "../protocol/sha.js";
import type { GitHubApi, GitHubProbeFailure, PullRequestSummary } from "./github-api.js";

/**
 * Pull-request metadata (advisory context, never identity).
 *
 * The PR number tells the adviser which review thread and which diff the user means; the anchor SHA
 * stays the coordinate (INV-03). Two properties are enforced here: selection is deterministic, and a
 * PR HEAD that moves is reported rather than followed.
 */

export type PullRequestDetection =
  | {
      readonly kind: "found";
      readonly pullRequest: PullRequestRef;
      /** More than one open PR shares this head (several base branches); the lowest number is used. */
      readonly ambiguous: boolean;
      readonly candidates: readonly number[];
      readonly baseRefName: string;
    }
  | { readonly kind: "none" }
  | { readonly kind: "probe-failed"; readonly failure: GitHubProbeFailure };

/** Deterministic PR selection: lowest number wins, so repeated runs agree. */
export function selectPullRequest(
  summaries: readonly PullRequestSummary[],
): Omit<Extract<PullRequestDetection, { kind: "found" }>, "kind"> | undefined {
  if (summaries.length === 0) return undefined;
  const sorted = [...summaries].sort((left, right) => left.number - right.number);
  const chosen = sorted[0]!;
  return {
    pullRequest: { number: chosen.number, headCommit: chosen.headSha },
    ambiguous: sorted.length > 1,
    candidates: sorted.map((summary) => summary.number),
    baseRefName: chosen.baseRefName,
  };
}

export async function detectOpenPullRequest(
  api: GitHubApi,
  repository: GitHubRepositoryKey,
  branchName: string,
): Promise<PullRequestDetection> {
  const outcome = await api.listOpenPullRequestsForHead(repository, branchName);
  if (!outcome.ok) return { kind: "probe-failed", failure: outcome.failure };

  const selected = selectPullRequest(outcome.value);
  if (selected === undefined) return { kind: "none" };
  return { kind: "found", ...selected };
}

/**
 * Whether the stored PR metadata still describes the PR.
 *
 * Returning a signal instead of updating the anchor is the whole point: retargeting an anchor to the
 * new PR HEAD would silently change what past advice meant, which is exactly what INV-03 forbids.
 */
export type PullRequestDrift =
  | { readonly state: "in-sync"; readonly observedHeadCommit: FullCommitSha }
  | { readonly state: "pr-head-moved"; readonly anchorCommit: FullCommitSha; readonly observedHeadCommit: FullCommitSha }
  | { readonly state: "unknown" };

export function assessPullRequestDrift(
  anchorPullRequest: PullRequestRef,
  observedHeadCommit: FullCommitSha | "unknown",
): PullRequestDrift {
  if (observedHeadCommit === "unknown") return { state: "unknown" };
  if (observedHeadCommit === anchorPullRequest.headCommit) {
    return { state: "in-sync", observedHeadCommit };
  }
  return {
    state: "pr-head-moved",
    anchorCommit: anchorPullRequest.headCommit,
    observedHeadCommit,
  };
}
