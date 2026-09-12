import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ToolManager } from "./tools.js";
import { DEFAULT_CONFIG } from "../config/schema.js";
import { fakeGit, CHECKPOINT_SHA } from "../test/fixtures.js";
import { ConsultationLedger } from "../ledger/ledger.js";
import { adviserStateLayout } from "../config/state-layout.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import type { ConsultationId } from "../protocol/checkpoint.js";
import type { GitHubApi } from "../git/github-api.js";
import type { ConsultationEngine } from "../jobs/engine.js";

const REPO = canonicalRepositoryKey("acme", "repo");
const COMMIT = requireFullCommitSha(CHECKPOINT_SHA);

const mockGitHub: GitHubApi = {
  checkCommitPresence: () => Promise.resolve({ ok: true, value: "present" as const }),
  listOpenPullRequestsForHead: () => Promise.resolve({ ok: true, value: [] }),
};

function makeGit(checkpointSha = CHECKPOINT_SHA) {
  const remotes = "origin\tgit@github.com:acme/repo.git (fetch)\norigin\tgit@github.com:acme/repo.git (push)\n";
  const { executor } = fakeGit({
    "rev-parse --show-toplevel": "/repo",
    "rev-parse --verify --quiet HEAD^{commit}": checkpointSha,
    "symbolic-ref --quiet --short HEAD": "main",
    "rev-parse --is-shallow-repository": "false",
    "worktree list --porcelain": `worktree /repo\nHEAD ${checkpointSha}\nbranch refs/heads/main\n\n`,
    "status --porcelain --untracked-files=all": "",
    "remote -v": remotes,
    "rev-parse --verify --quiet refs/remotes/origin/main": checkpointSha,
    [`merge-base --is-ancestor ${checkpointSha} ${checkpointSha}`]: { code: 0 },
    [`merge-base ${checkpointSha} ${checkpointSha}`]: { code: 0, stdout: `${checkpointSha}\n` },
    [`diff --name-status ${checkpointSha} ${checkpointSha}`]: "",
  });
  return executor;
}

function makeTestDirectory(prefix = "pwc-tools-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("extension/tools (M8)", () => {
  it("defines all 8 agent-facing tools", () => {
    const manager = new ToolManager({ github: mockGitHub });
    const tools = manager.getTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "advisor_auth",
      "advisor_cancel",
      "advisor_disposition",
      "advisor_followup",
      "advisor_preflight",
      "advisor_read",
      "advisor_status",
      "advisor_submit",
    ]);
  });

  it("executes advisor_preflight tool cleanly", async () => {
    const dir = makeTestDirectory("pwc-tools-preflight-");
    const git = makeGit();

    const manager = new ToolManager({ git, github: mockGitHub });
    const preflight = manager.getTools().find((t) => t.name === "advisor_preflight")!;

    const result = await preflight.execute("call-1", { cwd: dir }, undefined, undefined, { cwd: dir, isProjectTrusted: () => true });
    expect(result.content[0]!.text).toContain("Preflight");
    expect(result.details).toBeDefined();
  });

  it("refuses advisor_submit without an adviser engine and does not create a ledger record", async () => {
    const dir = makeTestDirectory("pwc-tools-submit-");
    const git = makeGit();

    const ledger = new ConsultationLedger({ layout: adviserStateLayout(dir) });
    const manager = new ToolManager({ git, github: mockGitHub, ledger });
    const submitTool = manager.getTools().find((t) => t.name === "advisor_submit")!;

    const piContext = {
      cwd: dir,
      sessionManager: { getSessionId: () => "test-tool-session" },
      isProjectTrusted: () => true,
    };
    const submitResult = await submitTool.execute(
      "call-2",
      { goal: "Review error handling", kind: "review", cwd: dir },
      undefined,
      undefined,
      piContext,
    );

    expect(submitResult.content[0]!.text).toContain("adviser engine unavailable");
    const details = submitResult.details as { consultationId: string; ok: boolean; failure: string };
    expect(details.consultationId).toBeDefined();
    expect(details.ok).toBe(false);
    expect(details.failure).toBe("engine-unavailable");
    expect(await ledger.list({ repository: REPO })).toHaveLength(0);
  });

  it("routes async advisor_submit through submitAsync and scopes it to Pi's session", async () => {
    const dir = makeTestDirectory("pwc-tools-async-");
    const git = makeGit();
    const submitAsync = vi.fn((request: { consultationId?: string; taskId: string }) => ({
      consultationId: request.consultationId!,
      address: {
        repository: REPO,
        taskId: request.taskId,
        consultationId: request.consultationId!,
        deliveryKey: "0".repeat(64),
      },
      state: "queued" as const,
    }));
    const submitSync = vi.fn();
    const engine = { submitAsync, submitSync } as unknown as ConsultationEngine;
    const manager = new ToolManager({
      config: { ...DEFAULT_CONFIG, defaultMode: "async" },
      git,
      github: mockGitHub,
      ledger: new ConsultationLedger({ layout: adviserStateLayout(dir) }),
      engine,
    });
    const submitTool = manager.getTools().find((t) => t.name === "advisor_submit")!;

    const result = await submitTool.execute(
      "call-async",
      { goal: "Queue async work", kind: "consult", cwd: dir },
      undefined,
      undefined,
      { cwd: dir, sessionManager: { getSessionId: () => "tool-session-async" }, isProjectTrusted: () => true },
    );

    expect(result.content[0]!.text).toContain("queued for asynchronous delivery");
    expect(result.details).toMatchObject({ ok: true, mode: "async", state: "queued" });
    expect(submitAsync).toHaveBeenCalledOnce();
    expect(submitSync).not.toHaveBeenCalled();
    expect(submitAsync.mock.calls[0]?.[0]).toMatchObject({ taskId: "tool-session-async", mode: "async" });
  });

  it("executes advisor_disposition tool", async () => {
    const dir = makeTestDirectory("pwc-tools-disp-");
    const git = makeGit();

    const ledger = new ConsultationLedger({ layout: adviserStateLayout(dir) });
    const consultationId = "adv-disp0001" as ConsultationId;
    await ledger.recordConsultation(
      {
        schemaVersion: 1,
        consultationId,
        taskId: "task-01",
        kind: "plan",
        status: "completed",
        dependency: "advisory",
        repository: REPO,
        branch: "main",
        requestedRef: "main",
        resolvedCommit: COMMIT,
        headAtDispatch: COMMIT,
        projectId: "proj-1",
        conversationId: "conv-1",
        createdAt: new Date().toISOString(),
        actionItems: [{ id: "A1", summary: "Initial step", disposition: "pending" }],
      },
      "Step 1",
    );

    const manager = new ToolManager({ git, github: mockGitHub, ledger });
    const dispTool = manager.getTools().find((t) => t.name === "advisor_disposition")!;

    const result = await dispTool.execute(
      "call-4",
      {
        consultationId,
        actionItemId: "A1",
        disposition: "rejected_with_reason",
        reason: "Approach not feasible with current architecture",
        cwd: dir,
      },
      undefined,
      undefined,
      { cwd: dir, isProjectTrusted: () => true },
    );

    expect(result.content[0]!.text).toContain("Action item A1 updated to rejected_with_reason.");

    const entries = await ledger.list({ repository: REPO });
    const updated = entries.find((e) => e.consultationId === consultationId);
    expect(updated?.actionItems[0]!.disposition).toBe("rejected_with_reason");
    expect(updated?.actionItems[0]!.dispositionNote).toBe("Approach not feasible with current architecture");
  });

  it("executes advisor_cancel and advisor_auth tools", async () => {
    const manager = new ToolManager({ github: mockGitHub });
    const cancelTool = manager.getTools().find((t) => t.name === "advisor_cancel")!;
    const authTool = manager.getTools().find((t) => t.name === "advisor_auth")!;

    const cancelResult = await cancelTool.execute("call-5", { consultationId: "adv-cancel99" });
    expect(cancelResult.content[0]!.text).toContain("does not trust this project");

    const authResult = await authTool.execute("call-6", {});
    expect(authResult.content[0]!.text).toBeDefined();
    expect(authResult.details).toBeDefined();
  });
});
