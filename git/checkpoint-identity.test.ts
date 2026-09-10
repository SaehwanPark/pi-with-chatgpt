/**
 * Consultation identity through the M1 pipeline (INV-03, INV-04).
 *
 * `protocol/checkpoint.test.ts` covers the types; these tests cover the properties that only exist
 * once resolution runs: the anchor a caller receives is the resolved commit (not the ref, not the PR
 * head), it is stable across repeated resolution, and nothing in the pipeline can produce a
 * dispatch-ready anchor from an unverified checkpoint.
 */
import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_SHA,
  OTHER_CHECKPOINT_SHA,
  REPO_KEY,
  fakeGit,
  type FakeGitOutcome,
} from "../test/fixtures.js";
import { checkDispatchReadiness, type RemoteAvailability } from "../protocol/checkpoint.js";
import type { GitHubApi, GitHubOutcome, ObjectPresence } from "./github-api.js";
import { resolveCheckpoint } from "./checkpoint-resolution.js";
import { assessPullRequestDrift } from "./pr-detection.js";

const REMOTES = `origin\thttps://github.com/SaehwanPark/pi-with-chatgpt.git (fetch)\n`;

function handlers(overrides: Record<string, FakeGitOutcome | string> = {}) {
  return {
    "rev-parse --show-toplevel": "/repo",
    "rev-parse --verify --quiet HEAD^{commit}": CHECKPOINT_SHA,
    "symbolic-ref --quiet --short HEAD": "feat/identity",
    "rev-parse --is-shallow-repository": "false",
    "worktree list --porcelain": `worktree /repo\nHEAD ${CHECKPOINT_SHA}\nbranch refs/heads/feat/identity\n\n`,
    "status --porcelain --untracked-files=all": "",
    "remote -v": REMOTES,
    "rev-parse --verify --quiet refs/remotes/origin/feat/identity": OTHER_CHECKPOINT_SHA,
    [`merge-base --is-ancestor ${OTHER_CHECKPOINT_SHA} ${CHECKPOINT_SHA}`]: { code: 0 },
    [`merge-base --is-ancestor ${CHECKPOINT_SHA} ${OTHER_CHECKPOINT_SHA}`]: { code: 1 },
    [`merge-base ${OTHER_CHECKPOINT_SHA} ${CHECKPOINT_SHA}`]: { code: 0, stdout: `${OTHER_CHECKPOINT_SHA}\n` },
    ...overrides,
  };
}

function apiFor(presence: GitHubOutcome<ObjectPresence>): GitHubApi {
  return {
    checkCommitPresence() {
      return Promise.resolve(presence);
    },
    listOpenPullRequestsForHead() {
      // The PR head deliberately differs from the checkpoint: metadata must never become identity.
      return Promise.resolve({
        ok: true as const,
        value: [{ number: 42, headSha: OTHER_CHECKPOINT_SHA, baseRefName: "main" }],
      });
    },
  };
}

async function resolveWith(presence: GitHubOutcome<ObjectPresence>, overrides: Record<string, FakeGitOutcome | string> = {}) {
  const { executor } = fakeGit(handlers(overrides));
  return resolveCheckpoint({ git: executor, github: apiFor(presence), cwd: "/repo", requestedRef: "HEAD" });
}

const AVAILABLE: GitHubOutcome<ObjectPresence> = { ok: true, value: "present" };

describe("resolved consultation identity (INV-03)", () => {
  it("anchors on the resolved commit while keeping the requested ref", async () => {
    const result = await resolveWith(AVAILABLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.resolved.anchor.resolvedCommit).toBe(CHECKPOINT_SHA);
    expect(result.resolved.anchor.requestedRef).toBe("HEAD");
    expect(result.resolved.anchor.repository).toBe(REPO_KEY);
  });

  it("is stable across repeated resolution of the same state", async () => {
    const first = await resolveWith(AVAILABLE);
    const second = await resolveWith(AVAILABLE);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Two consultations on the same state must be recognisable as being about the same thing, or the
    // ledger and drift reporting cannot match advice to code.
    expect(second.resolved.anchor).toEqual(first.resolved.anchor);
  });

  it("never adopts the PR head as the anchor", async () => {
    // The fake PR's head is a different commit on purpose: PR metadata is context, never identity.
    const result = await resolveWith(AVAILABLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.resolved.pullRequest?.kind).toBe("found");
    expect(result.resolved.anchor.pullRequest?.headCommit).toBe(OTHER_CHECKPOINT_SHA);
    expect(result.resolved.anchor.resolvedCommit).toBe(CHECKPOINT_SHA);

    const drift = assessPullRequestDrift(result.resolved.anchor.pullRequest!, CHECKPOINT_SHA);
    expect(drift.state).toBe("pr-head-moved");
    expect(result.resolved.anchor.resolvedCommit).toBe(CHECKPOINT_SHA);
  });

  it("freezes the anchor against in-place mutation", async () => {
    const result = await resolveWith(AVAILABLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const anchor = result.resolved.anchor;
    // `readonly` is a compile-time guarantee only; the value must also resist a determined writer,
    // because an anchor rewritten mid-consultation silently changes what past advice meant.
    expect(() => {
      (anchor as { resolvedCommit: string }).resolvedCommit = OTHER_CHECKPOINT_SHA;
    }).toThrow(TypeError);
  });
});

describe("dispatch gate (INV-04)", () => {
  // Excludes `available` on purpose: this is the list of states that must never dispatch.
  type Refusal = Exclude<RemoteAvailability, { status: "available" }>;
  const refusals: readonly Refusal[] = [
    { status: "unavailable", reason: "commit-not-on-remote" },
    { status: "unavailable", reason: "branch-ahead-of-remote" },
    { status: "unavailable", reason: "branch-diverged-from-remote" },
    { status: "unavailable", reason: "repository-not-pushed" },
    { status: "unknown", reason: "network-unreachable" },
    { status: "unknown", reason: "github-auth-failed" },
    { status: "unknown", reason: "remote-not-configured" },
    { status: "unknown", reason: "probe-timeout" },
    { status: "unknown", reason: "probe-inconclusive" },
  ];

  it("refuses dispatch for every non-available availability", () => {
    for (const remoteAvailability of refusals) {
      const readiness = checkDispatchReadiness({
        repository: REPO_KEY,
        remoteUrl: "https://github.com/SaehwanPark/pi-with-chatgpt",
        requestedRef: "HEAD",
        resolvedCommit: CHECKPOINT_SHA,
        remoteAvailability,
      });
      expect(readiness.ready, `${remoteAvailability.status}/${remoteAvailability.reason}`).toBe(false);
    }
  });

  it("produces no resolved checkpoint when the probe is inconclusive", async () => {
    const result = await resolveWith({ ok: true, value: "inconclusive" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.stage).toBe("availability");
  });

  it("produces no resolved checkpoint when the probe fails outright", async () => {
    const result = await resolveWith({
      ok: false,
      failure: { reason: "network-unreachable", detail: "unreachable" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe("checkpoint-not-remote");
  });
});
