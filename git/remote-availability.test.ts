import { describe, expect, it } from "vitest";

import { CHECKPOINT_SHA } from "../test/fixtures.js";
import {
  assessCheckpointAvailability,
  describeAvailability,
  isDispatchPermitted,
  type CheckpointObservations,
} from "./remote-availability.js";

function observations(overrides: Partial<CheckpointObservations>): CheckpointObservations {
  return {
    checkpoint: CHECKPOINT_SHA,
    remoteConfigured: true,
    remoteCommit: "present",
    remoteBranch: { sha: CHECKPOINT_SHA, relation: "equal" },
    hasUncommittedChanges: false,
    ...overrides,
  };
}

describe("assessCheckpointAvailability", () => {
  it("permits dispatch when the commit is on the remote", () => {
    const assessment = assessCheckpointAvailability(observations({}));
    expect(assessment.availability).toEqual({ status: "available" });
    expect(isDispatchPermitted(assessment)).toBe(true);
  });

  it("refuses a local-only commit as commit-not-on-remote", () => {
    const assessment = assessCheckpointAvailability(
      observations({
        remoteCommit: "absent",
        remoteBranch: { sha: CHECKPOINT_SHA, relation: "unrelated" },
      }),
    );
    expect(assessment.availability).toEqual({
      status: "unavailable",
      reason: "commit-not-on-remote",
    });
    expect(isDispatchPermitted(assessment)).toBe(false);
  });

  it("refuses a branch that is ahead of the remote", () => {
    const assessment = assessCheckpointAvailability(
      observations({
        remoteCommit: "absent",
        // Remote tip is an ancestor of the checkpoint: pushing would move the remote.
        remoteBranch: { sha: CHECKPOINT_SHA, relation: "left-ancestor-of-right" },
      }),
    );
    expect(assessment.availability).toEqual({
      status: "unavailable",
      reason: "branch-ahead-of-remote",
    });
  });

  it("refuses a diverged branch with the diverged reason, not the ahead reason", () => {
    const assessment = assessCheckpointAvailability(
      observations({
        remoteCommit: "absent",
        remoteBranch: { sha: CHECKPOINT_SHA, relation: "diverged" },
      }),
    );
    expect(assessment.availability).toEqual({
      status: "unavailable",
      reason: "branch-diverged-from-remote",
    });
  });

  it("refuses a repository that has never been pushed", () => {
    const assessment = assessCheckpointAvailability(
      observations({ remoteCommit: "absent", remoteBranch: undefined }),
    );
    expect(assessment.availability).toEqual({
      status: "unavailable",
      reason: "repository-not-pushed",
    });
  });

  it("refuses a repository with no configured remote", () => {
    const assessment = assessCheckpointAvailability(
      observations({ remoteConfigured: false, remoteCommit: "absent", remoteBranch: undefined }),
    );
    expect(assessment.availability).toEqual({
      status: "unavailable",
      reason: "repository-not-pushed",
    });
  });

  it("reports an inconclusive probe as unknown, never as available or as absent", () => {
    // A private repository queried with a limited token 404s exactly like a missing commit; saying
    // "not pushed" would send the user off to push work that is already public.
    const assessment = assessCheckpointAvailability(observations({ remoteCommit: "inconclusive" }));
    expect(assessment.availability).toEqual({ status: "unknown", reason: "probe-inconclusive" });
    expect(isDispatchPermitted(assessment)).toBe(false);
  });

  it.each([
    "network-unreachable",
    "github-auth-failed",
    "remote-not-configured",
    "probe-timeout",
  ] as const)("surfaces a %s transport failure as unknown", (reason) => {
    const assessment = assessCheckpointAvailability(observations({ probeFailure: reason }));
    expect(assessment.availability).toEqual({ status: "unknown", reason });
  });

  it("keeps an unanswerable branch relation unknown", () => {
    const assessment = assessCheckpointAvailability(
      observations({
        remoteCommit: "absent",
        remoteBranch: { sha: CHECKPOINT_SHA, relation: "unknown" },
      }),
    );
    expect(assessment.availability.status).toBe("unknown");
  });

  it("refuses contradictory observations instead of picking a story", () => {
    // "The object is absent" and "the object is an ancestor of the remote tip" cannot both hold.
    const assessment = assessCheckpointAvailability(
      observations({
        remoteCommit: "absent",
        remoteBranch: { sha: CHECKPOINT_SHA, relation: "right-ancestor-of-left" },
      }),
    );
    expect(assessment.availability).toEqual({ status: "unknown", reason: "probe-inconclusive" });
  });

  it("reports uncommitted work as drift without changing availability", () => {
    const pushed = assessCheckpointAvailability(observations({ hasUncommittedChanges: true }));
    expect(pushed.availability).toEqual({ status: "available" });
    // The adviser reads the pushed commit, not the dirty tree: the advisory is how the worker says so.
    expect(pushed.workingTreeDrift).toBe(true);

    const notPushed = assessCheckpointAvailability(
      observations({ remoteCommit: "absent", remoteBranch: undefined, hasUncommittedChanges: true }),
    );
    expect(notPushed.workingTreeDrift).toBe(true);
  });
});

describe("describeAvailability", () => {
  it("produces one non-empty sentence per availability", () => {
    const cases = [
      { status: "available" } as const,
      { status: "unavailable", reason: "commit-not-on-remote" } as const,
      { status: "unavailable", reason: "branch-ahead-of-remote" } as const,
      { status: "unavailable", reason: "branch-diverged-from-remote" } as const,
      { status: "unavailable", reason: "repository-not-pushed" } as const,
      { status: "unknown", reason: "network-unreachable" } as const,
      { status: "unknown", reason: "github-auth-failed" } as const,
      { status: "unknown", reason: "remote-not-configured" } as const,
      { status: "unknown", reason: "probe-timeout" } as const,
      { status: "unknown", reason: "probe-inconclusive" } as const,
    ];

    for (const availability of cases) {
      const text = describeAvailability(availability);
      expect(text.length).toBeGreaterThan(20);
      // This text can reach adviser context, so it must not carry local paths.
      expect(text).not.toMatch(/\/home\/|\bC:\\/);
    }
  });
});
