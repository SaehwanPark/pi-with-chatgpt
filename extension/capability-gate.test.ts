import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.js";
import { fakeGit, CHECKPOINT_SHA } from "../test/fixtures.js";
import { createConsultationCapabilityGate } from "../browser/consultation-capability.js";
import type { AdviserToolContext } from "./pi-api.js";
import type { ConsultationEngine } from "../jobs/engine.js";
import { ToolManager } from "./tools.js";
import type { GitHubApi } from "../git/github-api.js";

const github: GitHubApi = {
  checkCommitPresence: () => Promise.resolve({ ok: true, value: "present" as const }),
  listOpenPullRequestsForHead: () => Promise.resolve({ ok: true, value: [] }),
};

function git() {
  const remotes = "origin\tgit@github.com:acme/repo.git (fetch)\norigin\tgit@github.com:acme/repo.git (push)\n";
  return fakeGit({
    "rev-parse --show-toplevel": "/repo",
    "rev-parse --verify --quiet HEAD^{commit}": CHECKPOINT_SHA,
    "symbolic-ref --quiet --short HEAD": "main",
    "rev-parse --is-shallow-repository": "false",
    "worktree list --porcelain": `worktree /repo\nHEAD ${CHECKPOINT_SHA}\nbranch refs/heads/main\n\n`,
    "status --porcelain --untracked-files=all": "",
    "remote -v": remotes,
    "rev-parse --verify --quiet refs/remotes/origin/main": CHECKPOINT_SHA,
    [`merge-base --is-ancestor ${CHECKPOINT_SHA} ${CHECKPOINT_SHA}`]: { code: 0 },
    [`merge-base ${CHECKPOINT_SHA} ${CHECKPOINT_SHA}`]: { code: 0, stdout: `${CHECKPOINT_SHA}\n` },
    [`diff --name-status ${CHECKPOINT_SHA} ${CHECKPOINT_SHA}`]: "",
  }).executor;
}

function capabilityGate() {
  return createConsultationCapabilityGate({
    runtime: {
      probeSurface: () => Promise.resolve({ state: "conversation-ready" as const, actionable: true }),
      discoverModels: () => Promise.resolve({
        ok: true,
        models: [{ modelId: "gpt-5.5", displayName: "GPT-5.5", available: true }],
      }),
    },
    // No verifier is an explicit unverified result; it must never become a fake success.
  });
}

function context(cwd: string): AdviserToolContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => "session-for-gate-test" },
    isProjectTrusted: () => true,
  };
}

describe("production capability gate wiring", () => {
  it("preflight refuses when GitHub connector verification is absent", async () => {
    const manager = new ToolManager({
      config: DEFAULT_CONFIG,
      git: git(),
      github,
      capabilityGate: capabilityGate(),
    });
    const tool = manager.getTools().find((candidate) => candidate.name === "advisor_preflight");
    expect(tool).toBeDefined();

    const result = await tool!.execute("gate-preflight", {}, undefined, undefined, context("/repo"));
    expect(result.content[0]?.text).toContain("github-connector:unverified");
    expect(result.details).toMatchObject({ ready: false, reason: "capability" });
  });

  it("submit cannot bypass the same failing gate to call the engine", async () => {
    const submitSync = vi.fn();
    const engine = { submitSync } as unknown as ConsultationEngine;
    const manager = new ToolManager({
      config: DEFAULT_CONFIG,
      git: git(),
      github,
      engine,
      capabilityGate: capabilityGate(),
    });
    const tool = manager.getTools().find((candidate) => candidate.name === "advisor_submit");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      "gate-submit",
      { kind: "review", goal: "Review this checkpoint" },
      undefined,
      undefined,
      context("/repo"),
    );
    expect(result.content[0]?.text).toContain("github-connector:unverified");
    expect(result.details).toMatchObject({ ok: false, failure: "capability" });
    expect(submitSync).not.toHaveBeenCalled();
  });
});
