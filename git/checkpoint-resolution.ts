import {
  checkDispatchReadiness,
  type ConsultationAnchor,
  type DispatchReadiness,
  type RemoteProbeFailureReason,
} from "../protocol/checkpoint.js";
import type { FullCommitSha } from "../protocol/sha.js";
import type { GitExecutor } from "./exec.js";
import { compareCommits } from "./ancestry.js";
import type { GitHubApi, GitHubProbeFailure } from "./github-api.js";
import { detectOpenPullRequest, type PullRequestDetection } from "./pr-detection.js";
import {
  assessCheckpointAvailability,
  describeAvailability,
  type AvailabilityAssessment,
  type CheckpointObservations,
  type RemoteBranchObservation,
  type RemoteCommitObservation,
} from "./remote-availability.js";
import { resolveCheckpointRef } from "./ref-resolution.js";
import {
  RepositoryInspectionError,
  inspectRepository,
  selectPrimaryGitHubRemote,
  type RepositoryInspection,
} from "./repository.js";

/**
 * The M1 pipeline: ref → commit → selected GitHub remote → availability → anchor.
 *
 * This is the only place where the pieces are allowed to meet, and it is deliberately total: every
 * failure mode returns a structured refusal instead of throwing, so the extension layer can explain
 * what happened without parsing git or HTTP text. Nothing here commits, pushes, or touches the
 * network beyond the read-only GitHub probes in `github-api.ts` (INV-05, INV-06).
 */

export type CheckpointRefusal = {
  readonly stage: "ref" | "repository" | "remote" | "availability" | "identity";
  readonly reason: string;
  /** Sentence for the user; safe to show and free of local paths. */
  readonly explanation: string;
};

export type ResolvedCheckpoint = {
  readonly anchor: ConsultationAnchor;
  readonly assessment: AvailabilityAssessment;
  readonly observations: CheckpointObservations;
  readonly pullRequest: PullRequestDetection | undefined;
  /** Working-state context the UI needs; the anchor stays the authoritative identity. */
  readonly workingState: WorkingStateContext;
  readonly readiness: DispatchReadiness;
};

export type WorkingStateContext = {
  readonly repoRoot: string;
  readonly branch: string | undefined;
  readonly isShallow: boolean;
  readonly worktreeCount: number;
  readonly hasUncommittedChanges: boolean;
  readonly dirtyPathsSample: readonly string[];
  readonly remoteName: string | undefined;
  readonly selectionReason: string | undefined;
  readonly skippedRemotes: readonly { name: string; reason: string }[];
};

export type CheckpointResolution =
  | { readonly ok: true; readonly resolved: ResolvedCheckpoint }
  | { readonly ok: false; readonly refusal: CheckpointRefusal };

export interface CheckpointResolutionDependencies {
  readonly git: GitExecutor;
  readonly github: GitHubApi;
  readonly cwd: string;
  readonly requestedRef: string;
}

function remoteTrackingRef(remoteName: string, branchName: string): string {
  return `refs/remotes/${remoteName}/${branchName}`;
}

/**
 * The remote-tracking ref is the *last fetched* state: this subsystem never runs `git fetch` (that
 * writes refs, and the allowlist deliberately excludes it), so the branch relation is advisory
 * evidence for telling "ahead" from "diverged". The decisive reachability answer is the GitHub probe
 * of the exact object.
 */
async function readRemoteBranchTip(
  git: GitExecutor,
  cwd: string,
  remoteName: string,
  branchName: string,
): Promise<FullCommitSha | undefined> {
  const result = await git.runAllowingFailure(
    ["rev-parse", "--verify", "--quiet", remoteTrackingRef(remoteName, branchName)],
    cwd,
  );
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? (sha as FullCommitSha) : undefined;
}

function commitPresenceToObservation(
  outcome: Awaited<ReturnType<GitHubApi["checkCommitPresence"]>>,
): { remoteCommit: RemoteCommitObservation; probeFailure?: RemoteProbeFailureReason } {
  if (outcome.ok) return { remoteCommit: outcome.value };
  // A transport/auth failure outranks inference: absence was never established.
  return { remoteCommit: "inconclusive", probeFailure: outcome.failure.reason };
}

function inspectionRefusal(error: unknown, cwd: string): CheckpointRefusal {
  if (error instanceof RepositoryInspectionError) {
    return {
      stage: "repository",
      reason: error.reason,
      explanation:
        error.reason === "repository-has-no-commits"
          ? "This repository has no commits, so there is nothing to anchor a consultation on yet."
          : error.reason === "not-a-git-repository"
            ? "The current directory is not a git repository."
            : "The repository could not be inspected read-only.",
    };
  }
  return {
    stage: "repository",
    reason: "git-probe-failed",
    explanation: `Repository inspection failed in the current workspace (${cwd}).`,
  };
}

export async function resolveCheckpoint(
  dependencies: CheckpointResolutionDependencies,
): Promise<CheckpointResolution> {
  const { git, github, cwd, requestedRef } = dependencies;

  // Resolution first: a bad ref must not cost a repository inspection and a GitHub round trip.
  const resolution = await resolveCheckpointRef(git, cwd, requestedRef);
  if (!resolution.ok) {
    return {
      ok: false,
      refusal: { stage: "ref", reason: resolution.rejection.reason, explanation: resolution.rejection.explanation },
    };
  }
  const checkpoint = resolution.resolution.resolvedCommit;

  let inspection: RepositoryInspection;
  try {
    inspection = await inspectRepository(git, cwd);
  } catch (error) {
    return { ok: false, refusal: inspectionRefusal(error, cwd) };
  }

  const selection = selectPrimaryGitHubRemote(inspection.remotes);
  if (selection.kind === "no-github-remote") {
    return {
      ok: false,
      refusal: {
        stage: "remote",
        reason: "no-github-remote",
        explanation:
          `No configured remote points at a supported GitHub repository (considered: ${
            selection.considered.join(", ") || "none"
          }). V1 publishes context through GitHub only.`,
      },
    };
  }

  const branchName = inspection.head.kind === "branch" ? inspection.head.name : undefined;

  const presence = await github.checkCommitPresence(selection.key, checkpoint);
  const { remoteCommit, probeFailure } = commitPresenceToObservation(presence);

  let remoteBranch: RemoteBranchObservation | undefined;
  if (branchName !== undefined) {
    const tip = await readRemoteBranchTip(git, inspection.repoRoot, selection.remote.name, branchName);
    if (tip !== undefined) {
      const relation = await compareCommits(git, inspection.repoRoot, tip, checkpoint);
      remoteBranch = { sha: tip, relation: relation ?? "unknown" };
    }
  }

  const observations: CheckpointObservations = {
    checkpoint,
    remoteConfigured: true,
    remoteCommit,
    remoteBranch,
    hasUncommittedChanges: inspection.hasUncommittedChanges,
    ...(probeFailure !== undefined ? { probeFailure } : {}),
  };
  const assessment = assessCheckpointAvailability(observations);

  const anchor: ConsultationAnchor = {
    repository: selection.key,
    remoteUrl: selection.remote.url,
    requestedRef: resolution.resolution.requestedRef,
    resolvedCommit: checkpoint,
    remoteAvailability: assessment.availability,
  };

  // PR metadata is only fetched when there is something to advise on: a refused consultation must not
  // spend API quota, and the PR is useless without a dispatch.
  const pullRequest =
    branchName !== undefined && assessment.availability.status === "available"
      ? await detectOpenPullRequest(github, selection.key, branchName)
      : undefined;

  const anchored: ConsultationAnchor =
    pullRequest !== undefined && pullRequest.kind === "found"
      ? { ...anchor, pullRequest: pullRequest.pullRequest }
      : anchor;

  // Frozen as well as `readonly`: an anchor is the identity that advice, ledger records, and drift
  // reports are keyed on, so a later writer must not be able to retarget it in place (INV-03).
  const anchorValue: ConsultationAnchor = Object.freeze({
    ...anchored,
    ...(anchored.pullRequest !== undefined ? { pullRequest: Object.freeze({ ...anchored.pullRequest }) } : {}),
  });

  const readiness = checkDispatchReadiness(anchorValue);
  if (!readiness.ready) {
    return {
      ok: false,
      refusal: {
        stage: "availability",
        reason: readiness.code,
        explanation: `${readiness.explanation} ${describeAvailability(assessment.availability)}`,
      },
    };
  }

  return {
    ok: true,
    resolved: {
      anchor: readiness.anchor,
      assessment,
      observations,
      pullRequest,
      readiness,
      workingState: {
        repoRoot: inspection.repoRoot,
        branch: branchName,
        isShallow: inspection.isShallow,
        worktreeCount: inspection.worktrees.length,
        hasUncommittedChanges: inspection.hasUncommittedChanges,
        dirtyPathsSample: inspection.dirtyPathsSample,
        remoteName: selection.remote.name,
        selectionReason: selection.selectedBecause,
        skippedRemotes: selection.rejected.map((rejected) => ({
          name: rejected.name,
          reason: rejected.reason,
        })),
      },
    },
  };
}

/** Kept exported so the failure type is documented in one place for the extension layer (M6/M8). */
export function probeFailureDetail(failure: GitHubProbeFailure): string {
  return failure.detail;
}
