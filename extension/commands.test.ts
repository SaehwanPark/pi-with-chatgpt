import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandManager } from "./commands.js";
import { fakeGit, CHECKPOINT_SHA } from "../test/fixtures.js";
import { ConsultationLedger } from "../ledger/ledger.js";
import { adviserStateLayout } from "../config/state-layout.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import type { ConsultationId } from "../protocol/checkpoint.js";
import type { AdviserCommandContext, AdviserUi } from "./pi-api.js";
import type { GitHubApi } from "../git/github-api.js";

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

function makeTestDirectory(prefix = "pwc-cmd-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createMockContext(cwd: string): { ctx: AdviserCommandContext; notifications: Array<{ message: string; severity?: string }> } {
  const notifications: Array<{ message: string; severity?: string }> = [];
  const ui: AdviserUi = {
    notify(message: string, severity?: "info" | "warning" | "error") {
      notifications.push({ message, severity });
    },
  };
  return {
    ctx: { ui, cwd, sessionId: "test-session-123" },
    notifications,
  };
}

describe("extension/commands (M8)", () => {
  it("defines all 11 user-facing slash commands", () => {
    const manager = new CommandManager({ github: mockGitHub });
    const commands = manager.getCommands();
    const names = Object.keys(commands).sort();
    expect(names).toEqual([
      "advisor",
      "advisor-audit",
      "advisor-auth",
      "advisor-cancel",
      "advisor-challenge",
      "advisor-debug",
      "advisor-followup",
      "advisor-plan",
      "advisor-read",
      "advisor-review",
      "advisor-status",
    ]);
  });

  it("warns on empty request for /advisor", async () => {
    const manager = new CommandManager({ github: mockGitHub });
    const { ctx, notifications } = createMockContext("/tmp");
    await manager.getCommands()["advisor"]!.handler("", ctx);

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.severity).toBe("warning");
    expect(notifications[0]!.message).toContain("Usage: /advisor <request>");
  });

  it("handles /advisor consultation with git and ledger", async () => {
    const dir = makeTestDirectory("pwc-cmd-test-");
    const git = makeGit();

    const ledger = new ConsultationLedger({ layout: adviserStateLayout(dir) });
    const manager = new CommandManager({ git, github: mockGitHub, ledger });
    const { ctx, notifications } = createMockContext(dir);

    await manager.getCommands()["advisor"]!.handler("Design new caching layer", ctx);

    expect(notifications.length).toBeGreaterThanOrEqual(2);
    expect(notifications[0]!.message).toContain("[advisor:consult] dispatching");
    expect(notifications[1]!.message).toContain("[advisor:consult] Consultation");

    const records = await ledger.list({ repository: REPO });
    expect(records.length).toBe(1);
    expect(records[0]!.kind).toBe("consult");
    expect(records[0]!.resolvedCommit).toBe(COMMIT);
  });

  it("handles /advisor-review with default request when empty", async () => {
    const dir = makeTestDirectory("pwc-cmd-review-");
    const git = makeGit();

    const ledger = new ConsultationLedger({ layout: adviserStateLayout(dir) });
    const manager = new CommandManager({ git, github: mockGitHub, ledger });
    const { ctx, notifications } = createMockContext(dir);

    await manager.getCommands()["advisor-review"]!.handler("", ctx);

    expect(notifications[0]!.message).toContain("[advisor:review] dispatching");
    const records = await ledger.list({ repository: REPO });
    expect(records[0]!.kind).toBe("review");
  });

  it("handles /advisor-status and /advisor-read", async () => {
    const dir = makeTestDirectory("pwc-cmd-status-");
    const git = makeGit();

    const ledger = new ConsultationLedger({ layout: adviserStateLayout(dir) });
    const consultationId = "adv-status99" as ConsultationId;
    await ledger.recordConsultation(
      {
        schemaVersion: 1,
        consultationId,
        taskId: "task-01",
        kind: "audit",
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
        actionItems: [{ id: "A1", summary: "No critical flaws", disposition: "accepted" }],
      },
      "Security audit passed.",
    );

    const manager = new CommandManager({ git, github: mockGitHub, ledger });
    const { ctx, notifications } = createMockContext(dir);

    await manager.getCommands()["advisor-status"]!.handler(consultationId, ctx);
    expect(notifications.some((n) => n.message.includes("adv-status99: kind=audit"))).toBe(true);

    await manager.getCommands()["advisor-read"]!.handler(consultationId, ctx);
    expect(notifications.some((n) => n.message.includes("# Consultation Advisory: adv-status99"))).toBe(true);
  });

  it("handles /advisor-followup", async () => {
    const dir = makeTestDirectory("pwc-cmd-followup-");
    const git = makeGit();

    const ledger = new ConsultationLedger({ layout: adviserStateLayout(dir) });
    const origId = "adv-orig1234" as ConsultationId;
    await ledger.recordConsultation(
      {
        schemaVersion: 1,
        consultationId: origId,
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
        actionItems: [{ id: "A1", summary: "Initial step", disposition: "accepted" }],
      },
      "Initial plan.",
    );

    const manager = new CommandManager({ git, github: mockGitHub, ledger });
    const { ctx, notifications } = createMockContext(dir);

    await manager.getCommands()["advisor-followup"]!.handler(`${origId} Implement next step`, ctx);
    expect(notifications.some((n) => n.message.includes("dispatching"))).toBe(true);

    const all = await ledger.list({ repository: REPO });
    expect(all.length).toBe(2);
  });

  it("handles /advisor-cancel", async () => {
    const manager = new CommandManager({ github: mockGitHub });
    const { ctx, notifications } = createMockContext("/tmp");
    await manager.getCommands()["advisor-cancel"]!.handler("adv-cancel12", ctx);

    expect(notifications[0]!.message).toBe("Consultation adv-cancel12 cancelled.");
  });
});
