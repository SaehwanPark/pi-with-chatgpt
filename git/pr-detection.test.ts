import { describe, expect, it } from "vitest";

import { CHECKPOINT_SHA, OTHER_CHECKPOINT_SHA, REPO_KEY } from "../test/fixtures.js";
import type { GitHubApi, GitHubOutcome, PullRequestSummary } from "./github-api.js";
import { assessPullRequestDrift, detectOpenPullRequest, selectPullRequest } from "./pr-detection.js";

function summary(number: number, headSha: string, baseRefName = "main"): PullRequestSummary {
  return { number, headSha: headSha as PullRequestSummary["headSha"], baseRefName };
}

function fakeApi(
  outcome: GitHubOutcome<readonly PullRequestSummary[]>,
): { api: GitHubApi; calls: string[] } {
  const calls: string[] = [];
  const api: GitHubApi = {
    checkCommitPresence() {
      // Reaching this method is a bug: PR detection must not probe commit presence.
      return Promise.reject(new Error("PR detection must not probe commit presence"));
    },
    listOpenPullRequestsForHead(repository, headRef) {
      calls.push(`${repository}:${headRef}`);
      return Promise.resolve(outcome);
    },
  };
  return { api, calls };
}

describe("selectPullRequest", () => {
  it("returns nothing for an empty list", () => {
    expect(selectPullRequest([])).toBeUndefined();
  });

  it("picks the single PR", () => {
    const selected = selectPullRequest([summary(12, CHECKPOINT_SHA, "main")]);
    expect(selected?.pullRequest).toEqual({ number: 12, headCommit: CHECKPOINT_SHA });
    expect(selected?.ambiguous).toBe(false);
  });

  it("chooses the lowest number deterministically when one head has several PRs", () => {
    // Several open PRs on one head is legal (several base branches); arrival order must not decide
    // which one the adviser is told about.
    const first = selectPullRequest([
      summary(31, CHECKPOINT_SHA, "release/1"),
      summary(7, CHECKPOINT_SHA, "main"),
      summary(19, OTHER_CHECKPOINT_SHA, "next"),
    ]);
    const second = selectPullRequest([
      summary(19, OTHER_CHECKPOINT_SHA, "next"),
      summary(7, CHECKPOINT_SHA, "main"),
      summary(31, CHECKPOINT_SHA, "release/1"),
    ]);

    expect(first?.pullRequest.number).toBe(7);
    expect(second?.pullRequest.number).toBe(7);
    expect(first?.ambiguous).toBe(true);
    expect(first?.candidates).toEqual([7, 19, 31]);
  });
});

describe("detectOpenPullRequest", () => {
  it("reports no PR", async () => {
    const { api, calls } = fakeApi({ ok: true, value: [] });
    await expect(detectOpenPullRequest(api, REPO_KEY, "main")).resolves.toEqual({ kind: "none" });
    expect(calls).toEqual([`${REPO_KEY}:main`]);
  });

  it("reports the selected PR", async () => {
    const { api } = fakeApi({ ok: true, value: [summary(7, CHECKPOINT_SHA, "main")] });

    await expect(detectOpenPullRequest(api, REPO_KEY, "feat")).resolves.toMatchObject({
      kind: "found",
      pullRequest: { number: 7, headCommit: CHECKPOINT_SHA },
      baseRefName: "main",
    });
  });

  it("propagates a probe failure without inventing a PR", async () => {
    const { api } = fakeApi({
      ok: false,
      failure: { reason: "probe-timeout", detail: "timed out" },
    });

    await expect(detectOpenPullRequest(api, REPO_KEY, "main")).resolves.toEqual({
      kind: "probe-failed",
      failure: { reason: "probe-timeout", detail: "timed out" },
    });
  });
});

describe("assessPullRequestDrift", () => {
  const anchorPr = { number: 7, headCommit: CHECKPOINT_SHA };

  it("reports in-sync when the PR head is unchanged", () => {
    expect(assessPullRequestDrift(anchorPr, CHECKPOINT_SHA)).toEqual({
      state: "in-sync",
      observedHeadCommit: CHECKPOINT_SHA,
    });
  });

  it("reports a moved PR head without touching the anchor", () => {
    const drift = assessPullRequestDrift(anchorPr, OTHER_CHECKPOINT_SHA);
    expect(drift).toEqual({
      state: "pr-head-moved",
      anchorCommit: CHECKPOINT_SHA,
      observedHeadCommit: OTHER_CHECKPOINT_SHA,
    });
    // The anchor value is untouched: advice stays tied to what it was about (INV-03).
    expect(anchorPr.headCommit).toBe(CHECKPOINT_SHA);
  });

  it("reports unknown rather than stale when the observation is missing", () => {
    expect(assessPullRequestDrift(anchorPr, "unknown")).toEqual({ state: "unknown" });
  });
});
