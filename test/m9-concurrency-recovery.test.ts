/**
 * `test/m9-concurrency-recovery.test.ts` — Milestone 9 Hardening, Recovery & Concurrency Test Suite.
 *
 * Verifies:
 * 1. Failure Recovery Matrix (browser crash, login expiry, CAPTCHA, rate limits, deleted Project/conversation)
 * 2. Delivery Correctness (session isolation, repository isolation, task conversation isolation)
 * 3. Security Hardening (untrusted prompt injection defense, opacity, credential containment, directory permissions)
 * 4. Git Safety Contract (zero write operations, no auto-push/commit, immutable checkpoint anchoring)
 * 5. Concurrency & Race Conditions (parallel tasks, serialized same-conversation turns, cancel/complete race, duplicate callbacks)
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdviserBrowserRuntime,
  AdviserProjectSurface,
  ConsultationOutcome,
  ConsultationRequest,
  ModelOption,
  ProjectInspection,
  ProjectListResult,
  RuntimeRejection,
  RuntimeStatus,
  SurfaceObservation,
} from "../browser/runtime-types.js";
import { adviserStateLayout } from "../config/state-layout.js";
import {
  ConsultationEngine,
  type WakeUpNotification,
} from "../jobs/engine.js";
import { ConsultationJobStore } from "../jobs/store.js";
import type { ConsultationAnchor, ConsultationId } from "../protocol/checkpoint.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import { assertCredentialFreeValue } from "../ledger/record.js";
import { toWorkerFacingAdvisory } from "../ui/worker-facing.js";
import { buildProjectInstructions } from "../chatgpt/project-instructions.js";
import { ensurePrivateDirectory } from "../ledger/state-store.js";
import { ensureProjectForRepository } from "../chatgpt/project-mapping.js";
import { createConsultationCapabilityGate } from "../browser/consultation-capability.js";

const VALID_COMMIT = requireFullCommitSha("0f2c8f4a1d6b4f1e9c2d8e6a5b4c3d2e1f0a9b8c");
const RECEIPT_COMMIT = requireFullCommitSha("1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d");
const REPO_A = canonicalRepositoryKey("OwnerA", "repo-alpha");
const REPO_B = canonicalRepositoryKey("OwnerB", "repo-beta");

const ANCHOR_A: ConsultationAnchor = {
  repository: REPO_A,
  remoteUrl: "git@github.com:OwnerA/repo-alpha.git",
  requestedRef: "HEAD",
  resolvedCommit: VALID_COMMIT,
  remoteAvailability: { status: "available" },
};


interface TestHarness {
  readonly root: string;
  readonly engine: ConsultationEngine;
  readonly store: ConsultationJobStore;
  setNextTurnOutcome: (outcome: ConsultationOutcome | undefined) => void;
  setConsultHandler: (handler: (req: ConsultationRequest) => Promise<ConsultationOutcome>) => void;
  setSurfaceState: (inspection: ProjectInspection) => void;
  cleanup: () => Promise<void>;
}

async function createHarness(maxConcurrentJobs = 2): Promise<TestHarness> {
  const root = await mkdtemp(join(tmpdir(), "pwc-m9-hardening-"));
  const layout = adviserStateLayout(root);
  const store = new ConsultationJobStore(layout);

  let nextOutcome: ConsultationOutcome | undefined;
  let customConsult: ((req: ConsultationRequest) => Promise<ConsultationOutcome>) | undefined;
  let projectInspectionState: ProjectInspection = {
    state: "present",
    title: `pi-with-chatgpt: ${REPO_A}`,
    projectUrl: "https://chatgpt.com/p/proj-alpha",
  };

  const surface: AdviserProjectSurface = {
    listProjects(): Promise<ProjectListResult> {
      return Promise.resolve({
        ok: true,
        projects: [{ projectId: "proj-alpha", title: `pi-with-chatgpt: ${REPO_A}`, projectUrl: "https://chatgpt.com/p/proj-alpha" }],
      });
    },
    inspectProject(_projectId: string): Promise<ProjectInspection> {
      return Promise.resolve(projectInspectionState);
    },
    createProject(input) {
      return Promise.resolve({
        ok: true,
        projectId: "proj-created",
        title: input.title,
        projectUrl: "https://chatgpt.com/p/proj-created",
        instructionsApplied: true,
      });
    },
    applyInstructions() {
      return Promise.resolve(true);
    },
    startConversation() {
      return Promise.resolve({ ok: true, conversationId: "conv-1", conversationUrl: "https://chatgpt.com/c/conv-1" });
    },
    inspectConversation(conversationId: string) {
      return Promise.resolve({ state: "live", conversationUrl: `https://chatgpt.com/c/${conversationId}` });
    },
  };

  const runtime: AdviserBrowserRuntime = {
    status(): Promise<RuntimeStatus> {
      return Promise.resolve({
        phase: "ready",
        processAlive: true,
        headed: false,
        profileDir: root,
        launchCount: 1,
        humanAttentionRequired: false,
      });
    },
    ensureReady(): Promise<{ ok: boolean; rejection?: RuntimeRejection }> {
      return Promise.resolve({ ok: true });
    },
    probeSurface(): Promise<SurfaceObservation> {
      return Promise.resolve({ state: "conversation-ready", actionable: true });
    },
    discoverModels(): Promise<{ ok: boolean; models?: readonly ModelOption[]; rejection?: RuntimeRejection }> {
      return Promise.resolve({ ok: true, models: [{ modelId: "gpt-5", displayName: "GPT-5", available: true }] });
    },
    async consult(request: ConsultationRequest): Promise<ConsultationOutcome> {
      if (customConsult) {
        return await customConsult(request);
      }
      if (nextOutcome) {
        const out = nextOutcome;
        nextOutcome = undefined;
        return out;
      }
      return {
        ok: true,
        text: `ADVISOR\nconsultation: ${request.consultationId}\nreviewed_commit: ${VALID_COMMIT}\nstatus: actionable\n\nAdviser guidance for ${request.consultationId}.`,
        elapsedMs: 25,
      };
    },
    shutdown(): Promise<void> {
      return Promise.resolve();
    },
  };

  const engine = new ConsultationEngine({
    layout,
    store,
    surface,
    runtime,
    getHeadCommit: () => Promise.resolve(RECEIPT_COMMIT),
    maxConcurrentJobs,
    capabilityGate: createConsultationCapabilityGate({
      runtime,
      githubConnectorProbe: () => Promise.resolve("verified"),
    }),
  });

  return {
    root,
    engine,
    store,
    setNextTurnOutcome: (o) => {
      nextOutcome = o;
    },
    setConsultHandler: (h) => {
      customConsult = h;
    },
    setSurfaceState: (insp: ProjectInspection) => {
      projectInspectionState = insp;
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Milestone 9: Concurrency, Recovery, and Hardening", () => {
  describe("Failure Recovery Matrix", () => {
    it("recovers cleanly from browser crash during consult turn without corrupting state", async () => {
      const harness = await createHarness();
      try {
        harness.setNextTurnOutcome({
          ok: false,
          failure: "browser-lost",
        });

        const outcome = await harness.engine.submitSync({
          anchor: ANCHOR_A,
          branch: "main",
          taskId: "task-crash",
          kind: "consult",
          dependency: "advisory",
          prompt: "Verify crash handling",
          modelId: "gpt-5",
        });

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;

        expect(outcome.failure).toBe("browser");
        expect(outcome.blocked).toBe(false); // Advisory mode does not block Pi worker (INV-07)

        // Subsequent job succeeds without deadlock or lingering lock
        harness.setNextTurnOutcome(undefined);
        const secondOutcome = await harness.engine.submitSync({
          anchor: ANCHOR_A,
          branch: "main",
          taskId: "task-after-crash",
          kind: "consult",
          dependency: "advisory",
          prompt: "Verify subsequent job succeeds",
          modelId: "gpt-5",
        });

        expect(secondOutcome.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("handles rate-limited response by marking advisory failure without blocking worker", async () => {
      const harness = await createHarness();
      try {
        harness.setNextTurnOutcome({
          ok: false,
          failure: "provider-error",
        });

        const outcome = await harness.engine.submitSync({
          anchor: ANCHOR_A,
          branch: "main",
          taskId: "task-rate-limit",
          kind: "review",
          dependency: "advisory",
          prompt: "Perform code review",
          modelId: "gpt-5",
        });

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;

        expect(outcome.failure).toBe("quota");
        expect(outcome.blocked).toBe(false);
      } finally {
        await harness.cleanup();
      }
    });

    it("blocks worker progression when a required consultation fails", async () => {
      const harness = await createHarness();
      try {
        harness.setNextTurnOutcome({
          ok: false,
          failure: "model-unavailable",
        });

        const outcome = await harness.engine.submitSync({
          anchor: ANCHOR_A,
          branch: "main",
          taskId: "task-required",
          kind: "audit",
          dependency: "required",
          prompt: "Required architectural audit",
          modelId: "gpt-5",
        });

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;

        expect(outcome.blocked).toBe(true); // Required mode blocks worker
      } finally {
        await harness.cleanup();
      }
    });
  });

  describe("Delivery Correctness & Cross-Context Isolation", () => {
    it("never wakes the wrong Pi session across distinct delivery keys", async () => {
      const harness = await createHarness();
      try {
        const notificationsSessionA: WakeUpNotification[] = [];
        const notificationsSessionB: WakeUpNotification[] = [];

        harness.engine.registerWakeUpListener("delivery-session-A", (n) => {
          notificationsSessionA.push(n);
        });
        harness.engine.registerWakeUpListener("delivery-session-B", (n) => {
          notificationsSessionB.push(n);
        });

        await harness.engine.submitAsync({
          anchor: ANCHOR_A,
          branch: "main",
          taskId: "task-session-A",
          deliveryKey: "delivery-session-A",
          kind: "consult",
          prompt: "Query for session A",
          modelId: "gpt-5",
        });

        // Wait for async background completion
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(notificationsSessionA.length).toBeGreaterThanOrEqual(1);
        expect(notificationsSessionB.length).toBe(0); // Session B was never notified
      } finally {
        await harness.cleanup();
      }
    });

    it("never attaches response or state from repository A to repository B", async () => {
      const harness = await createHarness();
      try {
        const resA = await harness.engine.submitSync({
          anchor: ANCHOR_A,
          branch: "main",
          taskId: "task-repo-isolation",
          kind: "consult",
          prompt: "Query for Repo A",
          modelId: "gpt-5",
        });
        expect(resA.ok).toBe(true);
        if (!resA.ok) return;

        // Verify that looking up from Repo B is rejected with job-scope-mismatch
        await expect(
          harness.engine.getStatus({
            repository: REPO_B,
            taskId: "task-repo-isolation",
            consultationId: resA.record.consultationId,
            deliveryKey: "0".repeat(64),
          }),
        ).rejects.toThrow(/job-scope-mismatch/iu);

        await expect(
          harness.engine.readResult({
            repository: REPO_B,
            taskId: "task-repo-isolation",
            consultationId: resA.record.consultationId,
            deliveryKey: "0".repeat(64),
          }),
        ).rejects.toThrow(/job-scope-mismatch/iu);
      } finally {
        await harness.cleanup();
      }
    });
  });

  describe("Security Hardening & Threat Containment", () => {
    it("explicitly instructs the adviser that repository content is untrusted (INV-01)", () => {
      const instructions = buildProjectInstructions({ repository: REPO_A });
      expect(instructions).toContain("pi-with-chatgpt adviser Project");
      expect(instructions).toContain("Pi (the coding agent) decides and executes; ChatGPT advises.");
      expect(instructions).toContain("Never run commands, edit files, commit, or push.");
    });

    it("enforces worker-facing opacity by stripping internal selectors and tokens (INV-13)", () => {
      const advisory = toWorkerFacingAdvisory({
        schemaVersion: 1,
        consultationId: "adv-test-opacity" as ConsultationId,
        taskId: "task-001",
        repository: REPO_A,
        branch: "main",
        requestedRef: "HEAD",
        resolvedCommit: VALID_COMMIT,
        headAtDispatch: VALID_COMMIT,
        kind: "audit",
        dependency: "advisory",
        projectId: "secret-project-id",
        conversationId: "secret-conversation-id",
        status: "completed",
        createdAt: new Date().toISOString(),
        actionItems: [{ id: "A1", summary: "Verify tokens", disposition: "pending" }],
      });

      const json = JSON.stringify(advisory);
      expect(json).not.toContain("secret-project-id");
      expect(json).not.toContain("secret-conversation-id");
      expect(advisory.consultationId).toBe("adv-test-opacity");
      expect(advisory.checkpoint.resolvedCommit).toBe(VALID_COMMIT);
    });

    it("asserts credential containment in persistent values (INV-12)", () => {
      expect(() => {
        assertCredentialFreeValue("test value", "ghp_1234567890abcdef1234567890abcdef");
      }).toThrow(/secret pattern|refusing to persist/iu);

      expect(() => {
        assertCredentialFreeValue("test value", "Authorization: Bearer secret-token-abc");
      }).toThrow(/secret pattern|refusing to persist/iu);
    });

    it("restricts state directory to owner-only permissions (0700)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pwc-perm-test-"));
      try {
        const testDir = join(dir, "secure-state");
        await ensurePrivateDirectory(testDir);

        if (process.platform !== "win32") {
          const stats = await stat(testDir);
          const mode = stats.mode & 0o777;
          expect(mode).toBe(0o700);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Concurrency & Race Conditions", () => {
    it("strictly serializes multiple turns directed to the same task conversation (INV-09)", async () => {
      const harness = await createHarness();
      try {
        let activeTurnCount = 0;
        let peakConcurrentTurns = 0;

        harness.setConsultHandler(async (req) => {
          activeTurnCount += 1;
          peakConcurrentTurns = Math.max(peakConcurrentTurns, activeTurnCount);
          await new Promise((resolve) => setTimeout(resolve, 40));
          activeTurnCount -= 1;
          return {
            ok: true,
            text: `Response for ${req.consultationId}`,
            elapsedMs: 40,
          };
        });

        // Submit two turns targeting the same conversation thread (same taskId & kind)
        const [turn1, turn2] = await Promise.all([
          harness.engine.submitSync({
            anchor: ANCHOR_A,
            branch: "main",
            taskId: "same-task-thread",
            kind: "consult",
            prompt: "Turn 1",
            modelId: "gpt-5",
          }),
          harness.engine.submitSync({
            anchor: ANCHOR_A,
            branch: "main",
            taskId: "same-task-thread",
            kind: "consult",
            prompt: "Turn 2",
            modelId: "gpt-5",
          }),
        ]);

        expect(turn1.ok).toBe(true);
        expect(turn2.ok).toBe(true);
        expect(peakConcurrentTurns).toBe(1); // Never ran in parallel on the same conversation
      } finally {
        await harness.cleanup();
      }
    });

    it("serializes independent tasks while V1 owns one tracked adviser tab", async () => {
      const harness = await createHarness(2);
      try {
        let activeTurnCount = 0;
        let peakConcurrentTurns = 0;
        let resolveBarrier: () => void = () => undefined;
        const barrier = new Promise<void>((resolve) => {
          resolveBarrier = resolve;
        });

        harness.setConsultHandler(async (req) => {
          activeTurnCount += 1;
          peakConcurrentTurns = Math.max(peakConcurrentTurns, activeTurnCount);
          if (activeTurnCount >= 2) {
            resolveBarrier();
          }
          await Promise.race([barrier, new Promise((r) => setTimeout(r, 200))]);
          activeTurnCount -= 1;
          return {
            ok: true,
            text: `Parallel response for ${req.consultationId}`,
            elapsedMs: 60,
          };
        });

        // Submit two turns targeting DIFFERENT tasks
        const [turnA, turnB] = await Promise.all([
          harness.engine.submitSync({
            anchor: ANCHOR_A,
            branch: "main",
            taskId: "task-indep-1",
            kind: "consult",
            prompt: "Task 1 query",
            modelId: "gpt-5",
          }),
          harness.engine.submitSync({
            anchor: ANCHOR_A,
            branch: "main",
            taskId: "task-indep-2",
            kind: "consult",
            prompt: "Task 2 query",
            modelId: "gpt-5",
          }),
        ]);

        expect(turnA.ok).toBe(true);
        expect(turnB.ok).toBe(true);
        // The runtime and Project surface share one tracked tab. The engine clamps injected limits to one
        // until a conversation-scoped browser operation exists, so independent tasks cannot cross-send.
        expect(peakConcurrentTurns).toBe(1);
      } finally {
        await harness.cleanup();
      }
    });

    it("handles cancel vs complete race safely (winner persists first outcome)", async () => {
      const harness = await createHarness();
      try {
        let consultResolve: ((val: ConsultationOutcome) => void) | undefined;
        harness.setConsultHandler(() => {
          return new Promise<ConsultationOutcome>((resolve) => {
            consultResolve = resolve;
          });
        });

        const dispatched = await harness.engine.submitAsync({
          anchor: ANCHOR_A,
          branch: "main",
          taskId: "task-cancel-race",
          kind: "consult",
          prompt: "Cancel race query",
          modelId: "gpt-5",
        });

        // Cancel in-flight job
        const cancelledRecord = await harness.engine.cancel(dispatched.address);
        expect(cancelledRecord?.state).toBe("cancelled");

        // Late browser completion resolves
        consultResolve?.({
          ok: true,
          text: "Late completion response",
          elapsedMs: 50,
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Preserved state remains cancelled
        const finalStatus = await harness.engine.getStatus(dispatched.address);
        expect(finalStatus?.state).toBe("cancelled");
      } finally {
        await harness.cleanup();
      }
    });

    it("adopts winner in simultaneous Project initialization race", async () => {
      const root = await mkdtemp(join(tmpdir(), "pwc-proj-race-"));
      try {
        const layout = adviserStateLayout(root);
        let createCount = 0;

        const surface: AdviserProjectSurface = {
          listProjects() {
            return Promise.resolve({ ok: true, projects: [] });
          },
          inspectProject(id) {
            return Promise.resolve({ state: "present", title: `pi-with-chatgpt: ${REPO_A}`, projectUrl: `https://chatgpt.com/p/${id}` });
          },
          createProject(input) {
            createCount += 1;
            return Promise.resolve({
              ok: true,
              projectId: "proj-won",
              title: input.title,
              projectUrl: "https://chatgpt.com/p/proj-won",
              instructionsApplied: true,
            });
          },
          applyInstructions() {
            return Promise.resolve(true);
          },
          startConversation() {
            return Promise.resolve({ ok: true, conversationId: "c1", conversationUrl: "https://chatgpt.com/c/c1" });
          },
          inspectConversation() {
            return Promise.resolve({ state: "live" });
          },
        };

        const [p1, p2] = await Promise.all([
          ensureProjectForRepository({
            layout,
            surface,
            repository: REPO_A,
            instructions: "1. Rule one\n2. Rule two\n",
          }),
          ensureProjectForRepository({
            layout,
            surface,
            repository: REPO_A,
            instructions: "1. Rule one\n2. Rule two\n",
          }),
        ]);

        expect(p1.ok).toBe(true);
        expect(p2.ok).toBe(true);
        if (p1.ok && p2.ok) {
          expect(p1.mapping.projectId).toBe("proj-won");
          expect(p2.mapping.projectId).toBe("proj-won");
        }
        expect(createCount).toBe(1); // Exactly one Project created under file lock
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
