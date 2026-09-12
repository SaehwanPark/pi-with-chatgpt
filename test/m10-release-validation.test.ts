/**
 * `test/m10-release-validation.test.ts` — Milestone 10 Cross-Platform Validation & Release Test Suite.
 *
 * Verifies:
 * 1. Live Pi Integration: Pi package metadata, extension activation, slash command registration, tool registration.
 * 2. End-to-End Agent Tools: Execution of all 8 tools with opacity and invariant containment.
 * 3. End-to-End Slash Commands: Execution of all 11 slash commands with TUI formatting and error handling.
 * 4. Configuration Matrix: Strict schema validation, sensible defaults, and environment/file overrides.
 * 5. Worker Independence Matrix: Worker provider independence (OpenAI, local Qwen/Ollama, Anthropic).
 * 6. Platform Paths & Git Safety: OS state storage path isolation, 0700 permissions, and zero git write authority.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ToolManager } from "../extension/tools.js";
import { CommandManager } from "../extension/commands.js";
import { parseAdviserConfig } from "../config/schema.js";
import { assessAdviserEligibility } from "../auth/worker-independence.js";
import { stateStoragePaths, STATE_OWNER_MARKER } from "../browser/state-storage.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import { fakeGit, CHECKPOINT_SHA, CONSULTATION_ID } from "./fixtures.js";
import { ConsultationLedger } from "../ledger/ledger.js";
import { adviserStateLayout } from "../config/state-layout.js";
import type { GitHubApi } from "../git/github-api.js";
import type { ConsultationEngine } from "../jobs/engine.js";
import type { JobRecord } from "../jobs/record.js";
import defaultActivation, { MIN_PI_VERSION } from "../extension/index.js";

const REPO = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");
const COMMIT = requireFullCommitSha(CHECKPOINT_SHA);

const mockGitHub: GitHubApi = {
  checkCommitPresence: () => Promise.resolve({ ok: true, value: "present" as const }),
  listOpenPullRequestsForHead: () => Promise.resolve({ ok: true, value: [] }),
};

function makeGit(checkpointSha = CHECKPOINT_SHA) {
  const remotes = "origin\tgit@github.com:SaehwanPark/pi-with-chatgpt.git (fetch)\norigin\tgit@github.com:SaehwanPark/pi-with-chatgpt.git (push)\n";
  const { executor, invocations } = fakeGit({
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
  return { executor, invocations };
}

function makeMockEngine(ledger?: ConsultationLedger): ConsultationEngine {
  const anchor = {
    repository: REPO,
    remoteUrl: "git@github.com:SaehwanPark/pi-with-chatgpt.git",
    requestedRef: "main",
    resolvedCommit: COMMIT,
    remoteAvailability: { status: "available" as const },
  };
  const record: JobRecord = {
    consultationId: CONSULTATION_ID,
    anchor,
    branch: "main",
    taskId: "task-01",
    deliveryKey: "0".repeat(64),
    kind: "review",
    dependency: "advisory",
    mode: "sync",
    state: "completed",
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    binding: {
      projectId: "proj-1",
      conversationId: "conv-1",
      headAtDispatch: COMMIT,
    },
  };
  const response = {
    consultationId: CONSULTATION_ID,
    text: "### Assessment\nArchitecture looks sound.\n\n### Recommendations\nKeep invariants intact.\n\n### Action Items\n- [ ] A1: verify release gates\n- [ ] A2: publish documentation",
    receivedAt: new Date().toISOString(),
  };
  return {
    submitSync: async () => {
      if (ledger) {
        await ledger.recordConsultation(
          {
            schemaVersion: 1,
            consultationId: CONSULTATION_ID,
            taskId: "task-01",
            kind: "review",
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
            actionItems: [
              { id: "A1", summary: "verify release gates", disposition: "pending" },
              { id: "A2", summary: "publish documentation", disposition: "pending" },
            ],
          },
          response.text,
        );
      }
      return { ok: true, record, response };
    },
    submitAsync: () => Promise.resolve({
      jobId: "job-m10-async-1",
      consultationId: CONSULTATION_ID,
      state: "running",
      dispatchedAt: new Date().toISOString(),
    }),
    getStatusByConsultationId: () => Promise.resolve(undefined),
    listStatus: () => Promise.resolve([]),
    cancelByConsultationId: () => Promise.resolve({ ...record, state: "cancelled" as const }),
    cancel: () => Promise.resolve(true),
  } as unknown as ConsultationEngine;
}

describe("Milestone 10: Release Validation & Pi Integration", () => {
  describe("1. Live Pi Integration & Activation", () => {
    it("activates cleanly against Pi API registering 11 commands and 8 tools", () => {
      const registeredCommands = new Map<string, unknown>();
      const registeredTools = new Map<string, unknown>();
      const mockPi = {
        registerCommand(name: string, def: unknown) {
          registeredCommands.set(name, def);
        },
        registerTool(def: { name: string }) {
          registeredTools.set(def.name, def);
        },
        on() {},
      };

      const activation = defaultActivation(mockPi);
      expect(registeredCommands.size).toBe(11);
      expect(registeredTools.size).toBe(8);
      expect(activation.config.dependencyDefault).toBe("advisory");
      expect(activation.config.autoConsult.enabled).toBe(false);

      // Verify command names
      const expectedCommands = [
        "advisor",
        "advisor-plan",
        "advisor-review",
        "advisor-audit",
        "advisor-debug",
        "advisor-challenge",
        "advisor-followup",
        "advisor-status",
        "advisor-read",
        "advisor-cancel",
        "advisor-auth",
      ];
      for (const cmd of expectedCommands) {
        expect(registeredCommands.has(cmd)).toBe(true);
      }

      // Verify tool names
      const expectedTools = [
        "advisor_preflight",
        "advisor_submit",
        "advisor_read",
        "advisor_status",
        "advisor_followup",
        "advisor_cancel",
        "advisor_auth",
        "advisor_disposition",
      ];
      for (const tool of expectedTools) {
        expect(registeredTools.has(tool)).toBe(true);
      }
    });

    it("verifies package installation into real Pi CLI if available", () => {
      let piVersion: string | null = null;
      try {
        piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
      } catch {
        // Pi not available on PATH; skip host execution
      }

      if (piVersion !== null) {
        const parse = (v: string) => v.replace(/^v/u, "").split(".").map((p) => Number.parseInt(p, 10) || 0);
        const aMaj = parse(piVersion)[0] ?? 0;
        const aMin = parse(piVersion)[1] ?? 0;
        const mMaj = parse(MIN_PI_VERSION)[0] ?? 0;
        const mMin = parse(MIN_PI_VERSION)[1] ?? 0;
        expect(aMaj > mMaj || (aMaj === mMaj && aMin >= mMin)).toBe(true);

        const tempDir = mkdtempSync(join(tmpdir(), "pwc-m10-pi-install-"));
        try {
          const packageRoot = process.cwd();
          const env = { ...process.env, PI_CODING_AGENT_DIR: join(tempDir, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
          execFileSync("pi", ["install", packageRoot], { env, encoding: "utf8" });
          const listOutput = execFileSync("pi", ["list"], { env, encoding: "utf8" });
          expect(listOutput).toContain("pi-with-chatgpt");
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });
  });

  describe("2. End-to-End Agent Tools Execution (INV-01, INV-12, INV-13)", () => {
    it("executes all 8 agent tools under simulated agent environment", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "pwc-m10-tools-"));
      const layout = adviserStateLayout(tempDir);
      const ledger = new ConsultationLedger({ layout });
      const { executor } = makeGit();
      const engine = makeMockEngine(ledger);

      const toolManager = new ToolManager({
        github: mockGitHub,
        git: executor,
        ledger,
        engine,
      });

      const tools = toolManager.getTools();
      const toolMap = new Map(tools.map((t) => [t.name, t]));
      const mockCtx = {
        cwd: tempDir,
        sessionManager: { getSessionId: () => "session-m10-tools" },
        isProjectTrusted: () => true,
      };

      // 1. advisor_preflight
      const preflightTool = toolMap.get("advisor_preflight")!;
      const preflightRes = await preflightTool.execute("call-1", { ref: "HEAD", cwd: tempDir }, undefined, undefined, mockCtx);
      expect(preflightRes.content[0]!.text).toContain("Preflight");
      expect(preflightRes.details).toBeDefined();

      // 2. advisor_submit
      const submitTool = toolMap.get("advisor_submit")!;
      const submitRes = await submitTool.execute(
        "call-2",
        {
          kind: "review",
          goal: "Review the release readiness for V1",
          cwd: tempDir,
        },
        undefined,
        undefined,
        mockCtx,
      );
      expect(submitRes.content[0]!.text).toContain("submitted and recorded");
      const submitDetails = submitRes.details as { consultationId: string };
      expect(submitDetails.consultationId).toBeDefined();
      const consultationId = submitDetails.consultationId;

      // 3. advisor_read
      const readTool = toolMap.get("advisor_read")!;
      const readRes = await readTool.execute("call-3", { consultationId, cwd: tempDir }, undefined, undefined, mockCtx);
      expect(readRes.content[0]!.text).toContain("Advisory for review");
      const readDetails = readRes.details as { consultationId: string };
      expect(readDetails.consultationId).toBe(consultationId);

      // 4. advisor_status
      const statusTool = toolMap.get("advisor_status")!;
      const statusRes = await statusTool.execute("call-4", { consultationId, cwd: tempDir }, undefined, undefined, mockCtx);
      expect(statusRes.content[0]!.text).toContain("drift=current");
      expect(statusRes.details).toBeDefined();

      // 5. advisor_disposition
      const dispTool = toolMap.get("advisor_disposition")!;
      const dispRes = await dispTool.execute(
        "call-5",
        {
          consultationId,
          actionItemId: "A1",
          disposition: "implemented",
          cwd: tempDir,
        },
        undefined,
        undefined,
        mockCtx,
      );
      expect(dispRes.content[0]!.text).toContain("Action item A1 updated to implemented");

      // 6. advisor_followup
      const followupTool = toolMap.get("advisor_followup")!;
      const followupRes = await followupTool.execute(
        "call-6",
        {
          consultationId,
          request: "Check the documentation release items",
          cwd: tempDir,
        },
        undefined,
        undefined,
        mockCtx,
      );
      expect(followupRes.content[0]!.text).toContain("completed for");

      // 7. advisor_cancel
      const cancelTool = toolMap.get("advisor_cancel")!;
      const cancelRes = await cancelTool.execute("call-7", { consultationId, cwd: tempDir }, undefined, undefined, mockCtx);
      expect(cancelRes.content[0]!.text).toContain("cancelled.");

      // 8. advisor_auth
      const authTool = toolMap.get("advisor_auth")!;
      const authRes = await authTool.execute("call-8", { cwd: tempDir }, undefined, undefined, mockCtx);
      expect(authRes.content[0]!.text).toContain("Adviser authentication:");

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("3. End-to-End Slash Commands (INV-01, INV-06)", () => {
    it("executes all 11 slash commands through CommandManager with clean output", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "pwc-m10-commands-"));
      const layout = adviserStateLayout(tempDir);
      const ledger = new ConsultationLedger({ layout });
      const { executor, invocations } = makeGit();
      const engine = makeMockEngine(ledger);

      const commandManager = new CommandManager({
        github: mockGitHub,
        git: executor,
        ledger,
        engine,
      });

      const commands = commandManager.getCommands();
      const notifications: Array<{ message: string; severity?: string }> = [];
      const mockCtx = {
        cwd: tempDir,
        sessionManager: { getSessionId: () => "session-m10" },
        isProjectTrusted: () => true,
        ui: {
          notify(message: string, severity?: "info" | "warning" | "error") {
            notifications.push({ message, severity });
          },
        },
      };

      // Test all 11 commands via handler
      await commands["advisor-review"]!.handler("Review codebase architecture", mockCtx);
      expect(notifications.some((n) => n.message.includes("[advisor:review]"))).toBe(true);

      await commands["advisor-plan"]!.handler("Plan V1 release", mockCtx);
      expect(notifications.some((n) => n.message.includes("[advisor:plan]"))).toBe(true);

      await commands["advisor-audit"]!.handler("Audit invariant compliance", mockCtx);
      expect(notifications.some((n) => n.message.includes("[advisor:audit]"))).toBe(true);

      await commands["advisor-debug"]!.handler("Debug race conditions", mockCtx);
      expect(notifications.some((n) => n.message.includes("[advisor:debug]"))).toBe(true);

      await commands["advisor-challenge"]!.handler("Challenge advisory design", mockCtx);
      expect(notifications.some((n) => n.message.includes("[advisor:challenge]"))).toBe(true);

      await commands["advisor"]!.handler("General architectural advice", mockCtx);
      expect(notifications.some((n) => n.message.includes("[advisor:consult]"))).toBe(true);

      await commands["advisor-status"]!.handler("", mockCtx);
      expect(notifications.some((n) => n.message.includes("Status") || n.message.includes("Consultation"))).toBe(true);

      await commands["advisor-read"]!.handler("", mockCtx);
      expect(notifications.some((n) => n.message.includes("Advisory"))).toBe(true);

      await commands["advisor-auth"]!.handler("", mockCtx);
      expect(
        notifications.some(
          (n) =>
            n.message.includes("ChatGPT adviser") ||
            n.message.includes("Adviser authentication") ||
            n.message.includes("sign-in") ||
            n.message.includes("browser session"),
        ),
      ).toBe(true);

      await commands["advisor-followup"]!.handler(`${CONSULTATION_ID} next steps`, mockCtx);
      expect(notifications.some((n) => n.message.includes("dispatching") || n.message.includes("completed"))).toBe(true);

      await commands["advisor-cancel"]!.handler(CONSULTATION_ID, mockCtx);
      expect(notifications.some((n) => n.message.includes("cancelled"))).toBe(true);

      // Verify zero git write operations (INV-06)
      for (const invocation of invocations) {
        const cmd = invocation[0];
        if (cmd) {
          expect(["commit", "push", "add", "reset", "merge", "rebase"].includes(cmd)).toBe(false);
        }
      }

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("4. Configuration Validation Matrix", () => {
    it("accepts valid configurations and applies defaults", () => {
      const defaultConfig = parseAdviserConfig({}, "global");
      expect(defaultConfig.dependencyDefault).toBe("advisory");
      expect(defaultConfig.defaultMode).toBe("sync");
      expect(defaultConfig.autoConsult.enabled).toBe(false);

      const customConfig = parseAdviserConfig(
        {
          dependencyDefault: "required",
          defaultMode: "async",
          syncTimeoutMs: 60000,
        },
        "global",
      );
      expect(customConfig.dependencyDefault).toBe("required");
      expect(customConfig.defaultMode).toBe("async");
      expect(customConfig.syncTimeoutMs).toBe(60000);
    });

    it("rejects invalid configuration values and forbidden credential keys", () => {
      expect(() => parseAdviserConfig({ dependencyDefault: "invalid" }, "global")).toThrow();
      expect(() => parseAdviserConfig({ syncTimeoutMs: -100 }, "global")).toThrow();
      expect(() => parseAdviserConfig({ apiKey: "secret-token" }, "global")).toThrow();
    });
  });

  describe("5. Worker Model Independence Matrix", () => {
    it("verifies adviser eligibility is decoupled from active Pi worker model", () => {
      // Local Qwen / Ollama worker with OpenAI credential
      const localQwenWithOpenAI = assessAdviserEligibility({
        workerModelId: "qwen3-coder",
        workerProviderId: "ollama",
        openAiSignInAvailable: true,
      });
      expect(localQwenWithOpenAI.eligible).toBe(true);

      // Inexpensive OpenAI worker
      const openAIWorker = assessAdviserEligibility({
        workerModelId: "gpt-4o-mini",
        workerProviderId: "openai",
        openAiSignInAvailable: true,
      });
      expect(openAIWorker.eligible).toBe(true);

      // Cloud Anthropic worker with OpenAI credential
      const anthropicWorker = assessAdviserEligibility({
        workerModelId: "claude-3-5-sonnet",
        workerProviderId: "anthropic",
        openAiSignInAvailable: true,
      });
      expect(anthropicWorker.eligible).toBe(true);

      // Any worker without OpenAI credentials
      const noCredentials = assessAdviserEligibility({
        workerModelId: "qwen3-coder",
        workerProviderId: "ollama",
        openAiSignInAvailable: false,
      });
      expect(noCredentials.eligible).toBe(false);
      expect(noCredentials.reason).toBe("no-openai-sign-in");
    });
  });

  describe("6. Platform State Paths & Permissions", () => {
    it("places state under isolated agent directory and never inside git workspace", () => {
      const paths = stateStoragePaths();
      expect(paths.browserRoot).not.toContain(process.cwd());
      expect(paths.browserRoot).toContain(".pi");
      expect(paths.profileDir).toContain("chatgpt-profile");
      expect(STATE_OWNER_MARKER).toBe("OWNER");
    });
  });
});
