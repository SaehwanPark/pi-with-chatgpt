import type {
  RemoteAvailability,
  RemoteProbeFailureReason,
} from "../protocol/checkpoint.js";
import type { FullCommitSha } from "../protocol/sha.js";
import type { CommitRelation } from "./ancestry.js";

/**
 * The INV-04 decision: given what the probe observed, may this checkpoint be dispatched?
 *
 * This module is deliberately pure and I/O-free. It is the gate that protects the product's core
 * promise — the adviser reads the same code the worker means — so its logic must be reviewable and
 * testable without a repository, a network, or a token, and it must never be reachable through a
 * path that can "helpfully" default a missing answer to `available`.
 */

/** Direct answer to "is this exact object on the remote?" (GitHub commit API, or an equivalent). */
export type RemoteCommitObservation =
  | "present"
  | "absent"
  /** The probe ran but could not distinguish absent from invisible (a 404 on a private repository). */
  | "inconclusive";

export type RemoteBranchObservation = {
  readonly sha: FullCommitSha;
  /** Relation between the *remote* tip and the checkpoint: `left` = remote tip, `right` = checkpoint. */
  readonly relation: CommitRelation | "unknown";
};

export type CheckpointObservations = {
  readonly checkpoint: FullCommitSha;
  /** A repository with no configured GitHub remote has never been pushed anywhere. */
  readonly remoteConfigured: boolean;
  readonly remoteCommit: RemoteCommitObservation;
  /** The remote-tracking branch for the checked-out branch, when one exists. */
  readonly remoteBranch: RemoteBranchObservation | undefined;
  /** Whether the working tree differs from the checkpoint. Never changes availability. */
  readonly hasUncommittedChanges: boolean;
  /** A transport/auth failure observed during the probe. */
  readonly probeFailure?: RemoteProbeFailureReason;
};

export type AvailabilityAssessment = {
  readonly availability: RemoteAvailability;
  /**
   * The checkpoint is pushed, but the working tree contains work the adviser cannot see. Reported
   * separately because availability is about *the checkpoint*; silently downgrading availability
   * would hide the real hazard, which is a scope question, not a reachability one.
   */
  readonly workingTreeDrift: boolean;
};

function unavailable(
  availability: RemoteAvailability,
  hasUncommittedChanges: boolean,
): AvailabilityAssessment {
  return { availability, workingTreeDrift: hasUncommittedChanges };
}

/**
 * Classify a checkpoint against the selected remote.
 *
 * Order matters: an explicit probe failure outranks inference, and a direct answer about the object
 * outranks inference from a branch tip. Anything that cannot be concluded is `unknown`, never
 * `available`.
 */
export function assessCheckpointAvailability(
  observations: CheckpointObservations,
): AvailabilityAssessment {
  const { hasUncommittedChanges } = observations;

  if (observations.probeFailure !== undefined) {
    return unavailable({ status: "unknown", reason: observations.probeFailure }, hasUncommittedChanges);
  }
  if (!observations.remoteConfigured) {
    return unavailable(
      { status: "unavailable", reason: "repository-not-pushed" },
      hasUncommittedChanges,
    );
  }

  switch (observations.remoteCommit) {
    case "present":
      return unavailable({ status: "available" }, hasUncommittedChanges);
    case "inconclusive":
      // A 404 that may mean "cannot see it" must not be reported as "not there" (and never as "there").
      return unavailable(
        { status: "unknown", reason: "probe-inconclusive" },
        hasUncommittedChanges,
      );
    case "absent":
      break;
  }

  const branch = observations.remoteBranch;
  if (branch === undefined) {
    // The object is not on the remote and no branch of this repository is: nothing has been pushed.
    return unavailable(
      { status: "unavailable", reason: "repository-not-pushed" },
      hasUncommittedChanges,
    );
  }

  switch (branch.relation) {
    case "left-ancestor-of-right":
      // Remote tip is an ancestor of the checkpoint: the local branch has commits the remote lacks.
      return unavailable(
        { status: "unavailable", reason: "branch-ahead-of-remote" },
        hasUncommittedChanges,
      );
    case "diverged":
      return unavailable(
        { status: "unavailable", reason: "branch-diverged-from-remote" },
        hasUncommittedChanges,
      );
    case "unrelated":
      // Histories share nothing, so the only defensible statement is that this object is not there.
      return unavailable(
        { status: "unavailable", reason: "commit-not-on-remote" },
        hasUncommittedChanges,
      );
    case "right-ancestor-of-left":
    case "equal":
      // The checkpoint being an ancestor of (or identical to) the remote tip contradicts "the object
      // is absent": one of the two observations is stale. Refuse to guess.
      return unavailable(
        { status: "unknown", reason: "probe-inconclusive" },
        hasUncommittedChanges,
      );
    case "unknown":
      return unavailable(
        { status: "unknown", reason: "probe-inconclusive" },
        hasUncommittedChanges,
      );
  }
}

/**
 * One actionable sentence for the user-facing refusal.
 *
 * This text may be embedded in a later consultation, so it must stay free of local paths, hostnames
 * beyond the repository the user already knows, and anything credential-shaped.
 */
export function describeAvailability(availability: RemoteAvailability): string {
  switch (availability.status) {
    case "available":
      return "The checkpoint commit is reachable on the selected GitHub remote.";
    case "unavailable":
      switch (availability.reason) {
        case "commit-not-on-remote":
          return "This commit is not on the GitHub remote, so ChatGPT could not read it. Push the commit (your decision, your command) and consult again.";
        case "branch-ahead-of-remote":
          return "Your branch is ahead of the GitHub remote, so this commit is not yet readable by ChatGPT. Push it first if you want the adviser to see it.";
        case "branch-diverged-from-remote":
          return "Your branch and the GitHub remote have diverged, so the adviser's view of this commit may differ from your working state. Reconcile the branch, then consult again.";
        case "repository-not-pushed":
          return "This repository or branch has not been pushed to the configured GitHub remote, so there is nothing for ChatGPT to read yet.";
      }
      // Unreachable for a well-typed reason; kept so a future reason cannot render as `undefined`.
      return "Checkpoint reachability could not be determined.";
    case "unknown":
      switch (availability.reason) {
        case "network-unreachable":
          return "Could not reach GitHub to verify the checkpoint, so the consultation was not dispatched. Check connectivity and retry.";
        case "github-auth-failed":
          return "GitHub rejected the credentials used to verify the checkpoint, so the consultation was not dispatched. Check the configured token scopes.";
        case "remote-not-configured":
          return "No usable GitHub remote was configured, so the checkpoint could not be verified.";
        case "probe-timeout":
          return "Verifying the checkpoint against GitHub timed out, so the consultation was not dispatched. Retry when the network is responsive.";
        case "probe-inconclusive":
          return "GitHub returned an ambiguous answer about whether this commit is published (a private repository with a limited token looks identical to a missing commit), so the consultation was not dispatched.";
      }
  }
  return "Checkpoint reachability could not be determined.";
}

/** Whether a checkpoint may proceed to adviser dispatch (INV-04 gate). */
export function isDispatchPermitted(assessment: AvailabilityAssessment): boolean {
  return assessment.availability.status === "available";
}
