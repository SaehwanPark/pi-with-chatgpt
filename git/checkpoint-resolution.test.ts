import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_SHA,
  OTHER_CHECKPOINT_SHA,
  REPO_KEY,
  fakeGit,
  type FakeGitOutcome,
} from "../test/fixtures.js";
import type { GitHubApi, GitHubOutcome, ObjectPresence, PullRequestSummary } from "./github-api.js";
import { resolveCheckpoint } from "./checkpoint-resolution.js";

const REMOTES = `origin\thttps://github.com/SaehwanPark/pi-with-chatgpt.git (fetch)\norigin\thttps://github.com/SaehwanPark/pi-with-chatgpt.git (push)\n`;

function githubHandlers(options: {
  readonly presence?: GitHubOutcome<ObjectPresence>;
  readonly pullRequests?: GitHubOutcome<readonly PullRequestSummary[]>;
}) {
  const calls: string[] = [];
  const api: GitHubApi = {
    checkCommitPresence(repository, commit) {
      calls.push(`commit:${repository}:${commit.slice(0, 7)}`);
      return Promise.resolve(options.presence ?? { ok: true, value: "present" as const });
    },
    listOpenPullRequestsForHead(repository, headRef) {
      calls.push(`pr:${repository}:${headRef}`);
      return Promise.resolve(options.pullRequests ?? { ok: true, value: [] });
    },
  };
  return { api, calls };
}

function gitHandlers(overrides: Record<string, FakeGitOutcome | string> = {}) {
  return {
    "rev-parse --show-toplevel": "/repo",
    "rev-parse --verify --quiet HEAD^{commit}": CHECKPOINT_SHA,
    "symbolic-ref --quiet --short HEAD": "main",
    "rev-parse --is-shallow-repository": "false",
    "worktree list --porcelain": `worktree /repo\nHEAD ${CHECKPOINT_SHA}\nbranch refs/heads/main\n\n`,
    "status --porcelain --untracked-files=all": "",
    "remote -v": REMOTES,
    // The remote-tracking tip differs from the checkpoint: the branch is behind, which is the normal
    // state after a fetch, and the exact-object probe is what decides availability.
    "rev-parse --verify --quiet refs/remotes/origin/main": OTHER_CHECKPOINT_SHA,
    [`merge-base --is-ancestor ${OTHER_CHECKPOINT_SHA} ${CHECKPOINT_SHA}`]: { code: 0 },
    [`merge-base --is-ancestor ${CHECKPOINT_SHA} ${OTHER_CHECKPOINT_SHA}`]: { code: 1 },
    [`merge-base ${OTHER_CHECKPOINT_SHA} ${CHECKPOINT_SHA}`]: { code: 0, stdout: `${OTHER_CHECKPOINT_SHA}\n` },
    ...overrides,
  };
}

async function resolve(options: {
  readonly handlers?: Record<string, FakeGitOutcome | string>;
  readonly presence?: GitHubOutcome<ObjectPresence>;
  readonly pullRequests?: GitHubOutcome<readonly PullRequestSummary[]>;
  readonly requestedRef?: string;
}) {
  const { executor, invocations } = fakeGit(options.handlers ?? gitHandlers());
  const { api, calls } = githubHandlers({
    presence: options.presence,
    pullRequests: options.pullRequests,
  });
  const result = await resolveCheckpoint({
    git: executor,
    github: api,
    cwd: "/repo",
    requestedRef: options.requestedRef ?? "HEAD",
  });
  return { invocations, githubCalls: calls, result };
}

describe("resolveCheckpoint", () => {
  it("produces a dispatch-ready anchor for a pushed checkpoint", async () => {
    const { result, githubCalls } = await resolve({
      pullRequests: { ok: true, value: [{ number: 7, headSha: CHECKPOINT_SHA, baseRefName: "main" }] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.anchor).toEqual({
      repository: REPO_KEY,
      remoteUrl: "https://github.com/SaehwanPark/pi-with-chatgpt.git",
      requestedRef: "HEAD",
      resolvedCommit: CHECKPOINT_SHA,
      pullRequest: { number: 7, headCommit: CHECKPOINT_SHA },
      remoteAvailability: { status: "available" },
    });
    // PR metadata is fetched only for a consultation that will actually be dispatched.
    expect(githubCalls).toContain(`pr:${REPO_KEY}:main`);
  });

  it("reports uncommitted work as drift without blocking the consultation", async () => {
    const { result } = await resolve({
      handlers: gitHandlers({
        "status --porcelain --untracked-files=all": " M src/app.ts\n",
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.assessment.workingTreeDrift).toBe(true);
    expect(result.resolved.workingState.hasUncommittedChanges).toBe(true);
    expect(result.resolved.workingState.dirtyPathsSample).toEqual(["src/app.ts"]);
  });

  it("permits a checkpoint the remote has moved past, because the object itself is published", async () => {
    // The branch being behind is normal after a fetch and says nothing about whether the adviser can
    // read *this* commit; the exact-object probe decides.
    const { result } = await resolve({
      handlers: gitHandlers({
        [`merge-base --is-ancestor ${OTHER_CHECKPOINT_SHA} ${CHECKPOINT_SHA}`]: { code: 1 },
        [`merge-base --is-ancestor ${CHECKPOINT_SHA} ${OTHER_CHECKPOINT_SHA}`]: { code: 0 },
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.observations.remoteBranch?.relation).toBe("right-ancestor-of-left");
    expect(result.resolved.anchor.remoteAvailability).toEqual({ status: "available" });
  });

  it("refuses a local-only commit and never asks about a PR", async () => {
    const { result, githubCalls } = await resolve({
      presence: { ok: true, value: "absent" },
      handlers: gitHandlers({
        // No remote-tracking ref: nothing of this branch has been pushed.
        "rev-parse --verify --quiet refs/remotes/origin/main": { code: 1, stdout: "" },
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toMatchObject({
      stage: "availability",
      reason: "checkpoint-not-remote",
    });
    expect(result.refusal.explanation).toContain("repository-not-pushed");
    expect(githubCalls.filter((call) => call.startsWith("pr:"))).toEqual([]);
  });

  it("refuses when an inconclusive probe leaves reachability unverified", async () => {
    const { result } = await resolve({ presence: { ok: true, value: "inconclusive" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.explanation).toContain("ambiguous");
  });

  it("refuses on a transport failure with the underlying reason", async () => {
    const { result } = await resolve({
      presence: { ok: false, failure: { reason: "probe-timeout", detail: "timed out" } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.explanation).toContain("timed out");
  });

  it("refuses a workspace with no GitHub remote before any network call", async () => {
    const { result, githubCalls } = await resolve({
      handlers: gitHandlers({
        "remote -v": "origin\thttps://gitlab.com/o/r.git (fetch)\n",
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toMatchObject({ stage: "remote", reason: "no-github-remote" });
    expect(githubCalls).toEqual([]);
  });

  it("refuses an unresolvable ref without inspecting the repository", async () => {
    const { executor } = fakeGit(gitHandlers());
    const { api, calls } = githubHandlers({});

    const result = await resolveCheckpoint({
      git: executor,
      github: api,
      cwd: "/repo",
      requestedRef: "--upload-pack=/bin/sh",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.stage).toBe("ref");
    expect(calls).toEqual([]);
  });

  it("refuses outside a repository with a structured reason", async () => {
    const { result } = await resolve({
      handlers: {
        "rev-parse --verify --quiet HEAD^{commit}": CHECKPOINT_SHA,
        "rev-parse --show-toplevel": { code: 128, stderr: "fatal: not a git repository" },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toMatchObject({ stage: "repository", reason: "not-a-git-repository" });
  });

  it("skips branch-derived evidence for a detached HEAD", async () => {
    const { result } = await resolve({
      handlers: gitHandlers({
        "symbolic-ref --quiet --short HEAD": { code: 1, stdout: "" },
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No branch means no remote-tracking ref and no PR lookup; the exact-object probe still decides.
    expect(result.resolved.observations.remoteBranch).toBeUndefined();
    expect(result.resolved.pullRequest).toBeUndefined();
    expect(result.resolved.workingState.branch).toBeUndefined();
  });

  it("carries skipped-remote diagnostics so a fork setup is explainable", async () => {
    const { result } = await resolve({
      handlers: gitHandlers({
        "remote -v":
          "gitlab\thttps://gitlab.com/o/r.git (fetch)\n" +
          "origin\thttps://github.com/SaehwanPark/pi-with-chatgpt.git (fetch)\n",
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.workingState.remoteName).toBe("origin");
    expect(result.resolved.workingState.selectionReason).toBe("preferred-origin");
    expect(result.resolved.workingState.skippedRemotes).toEqual([{ name: "gitlab", reason: "unsupported-host" }]);
  });
});
