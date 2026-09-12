import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
  type EngineConsultationRequest,
  type WakeUpNotification,
} from "./engine.js";
import { ConsultationJobStore, jobAddress } from "./store.js";
import type { ConsultationAnchor } from "../protocol/checkpoint.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";

const VALID_COMMIT = requireFullCommitSha("0f2c8f4a1d6b4f1e9c2d8e6a5b4c3d2e1f0a9b8c");
const RECEIPT_COMMIT = requireFullCommitSha("1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d");
const REPOSITORY = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");

const VALID_ANCHOR: ConsultationAnchor = {
  repository: REPOSITORY,
  remoteUrl: "git@github.com:SaehwanPark/pi-with-chatgpt.git",
  requestedRef: "HEAD",
  resolvedCommit: VALID_COMMIT,
  remoteAvailability: { status: "available" },
};

describe("ConsultationEngine (M5)", () => {
  it("executes a synchronous consultation to durable completion", async () => {
    const fixture = await createEngineFixture();
    try {
      const request: EngineConsultationRequest = {
        anchor: VALID_ANCHOR,
        branch: "main",
        requestedRef: "HEAD",
        taskId: "task-1",
        deliveryKey: "delivery-pi-1",
        kind: "consult",
        dependency: "advisory",
        mode: "sync",
        prompt: "How should I structure this?",
        modelId: "gpt-5",
      };

      const outcome = await fixture.engine.submitSync(request);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.record.state).toBe("completed");
      expect(outcome.record.anchor.resolvedCommit).toBe(VALID_COMMIT);
      expect(outcome.record.result?.resultStatus).toBe("complete");
      expect(outcome.record.result?.headAtReceipt).toBe(RECEIPT_COMMIT);
      expect(outcome.response.text).toBe("Adviser answer: consider pattern X.");

      // Check durable store has the exact record
      const stored = await fixture.engine.getStatus(outcome.response);
      expect(stored?.state).toBe("completed");
      const storedResponse = await fixture.engine.readResult(outcome.response);
      expect(storedResponse?.text).toBe("Adviser answer: consider pattern X.");
    } finally {
      await fixture.cleanup();
    }
  });

  it("dispatches an asynchronous consultation and wakes matching Pi session", async () => {
    const fixture = await createEngineFixture();
    try {
      const notifications: WakeUpNotification[] = [];
      const unsubscribe = fixture.engine.registerWakeUpListener("delivery-pi-async", (n) => {
        notifications.push(n);
      });

      const request: EngineConsultationRequest = {
        anchor: VALID_ANCHOR,
        branch: "feat",
        requestedRef: "HEAD",
        taskId: "task-async",
        deliveryKey: "delivery-pi-async",
        kind: "plan",
        dependency: "advisory",
        mode: "async",
        prompt: "Plan the migration.",
        modelId: "gpt-5",
      };

      const dispatched = await fixture.engine.submitAsync(request);
      expect(dispatched.consultationId).toMatch(/^adv-/);
      expect(dispatched.state).toBe("queued");

      // Wait briefly for background execution to complete
      await waitFor(() => notifications.length > 0);

      expect(notifications.length).toBe(1);
      const notification = notifications[0]!;
      expect(notification.address.consultationId).toBe(dispatched.consultationId);
      expect(notification.state).toBe("completed");
      expect(notification.response?.text).toBe("Adviser answer: consider pattern X.");

      unsubscribe();
    } finally {
      await fixture.cleanup();
    }
  });

  it("prevents cross-delivery to unrelated Pi session wake-up listeners (INV-09)", async () => {
    const fixture = await createEngineFixture();
    try {
      const session1Notifications: WakeUpNotification[] = [];
      const session2Notifications: WakeUpNotification[] = [];

      fixture.engine.registerWakeUpListener("session-1-key", (n) => session1Notifications.push(n));
      fixture.engine.registerWakeUpListener("session-2-key", (n) => session2Notifications.push(n));

      const request: EngineConsultationRequest = {
        anchor: VALID_ANCHOR,
        branch: "feat",
        requestedRef: "HEAD",
        taskId: "task-session-1",
        deliveryKey: "session-1-key",
        kind: "consult",
        prompt: "Question from session 1",
        modelId: "gpt-5",
      };

      await fixture.engine.submitAsync(request);
      await waitFor(() => session1Notifications.length > 0);

      expect(session1Notifications.length).toBe(1);
      expect(session2Notifications.length).toBe(0); // Strictly isolated (INV-09)
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes consultations within the same task conversation (INV-09)", async () => {
    const fixture = await createEngineFixture();
    try {
      let activeInTurn = 0;
      let maxActiveInTurn = 0;

      fixture.setTurnDelay(25, () => {
        activeInTurn += 1;
        maxActiveInTurn = Math.max(maxActiveInTurn, activeInTurn);
      }, () => {
        activeInTurn -= 1;
      });

      const req1: EngineConsultationRequest = {
        anchor: VALID_ANCHOR,
        branch: "main",
        requestedRef: "HEAD",
        taskId: "same-task",
        deliveryKey: "delivery-1",
        kind: "consult",
        prompt: "First question",
        modelId: "gpt-5",
      };

      const req2: EngineConsultationRequest = {
        anchor: VALID_ANCHOR,
        branch: "main",
        requestedRef: "HEAD",
        taskId: "same-task",
        deliveryKey: "delivery-1",
        kind: "consult",
        prompt: "Follow up question",
        modelId: "gpt-5",
      };

      const [res1, res2] = await Promise.all([
        fixture.engine.submitSync(req1),
        fixture.engine.submitSync(req2),
      ]);

      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      // Because both target the same task and kind, they share the conversation and MUST run sequentially
      expect(maxActiveInTurn).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("allows parallel consultations across independent task conversations (M5 exit criterion)", async () => {
    const fixture = await createEngineFixture();
    try {
      let activeInTurn = 0;
      let maxActiveInTurn = 0;
      let resolveBarrier: () => void = () => undefined;
      const barrier = new Promise<void>((resolve) => {
        resolveBarrier = resolve;
      });

      fixture.setTurnDelay(
        0,
        () => {
          activeInTurn += 1;
          maxActiveInTurn = Math.max(maxActiveInTurn, activeInTurn);
          if (activeInTurn >= 2) {
            resolveBarrier();
          }
        },
        () => {
          activeInTurn -= 1;
        },
        async () => {
          await Promise.race([barrier, new Promise((r) => setTimeout(r, 200))]);
        },
      );

      const taskA: EngineConsultationRequest = {
        anchor: VALID_ANCHOR,
        branch: "main",
        requestedRef: "HEAD",
        taskId: "task-A",
        deliveryKey: "delivery-A",
        kind: "consult",
        prompt: "Question from task A",
        modelId: "gpt-5",
      };

      const taskB: EngineConsultationRequest = {
        anchor: VALID_ANCHOR,
        branch: "main",
        requestedRef: "HEAD",
        taskId: "task-B",
        deliveryKey: "delivery-B",
        kind: "plan",
        prompt: "Question from task B",
        modelId: "gpt-5",
      };

      const [resA, resB] = await Promise.all([
        fixture.engine.submitSync(taskA),
        fixture.engine.submitSync(taskB),
      ]);

      expect(resA.ok).toBe(true);
      expect(resB.ok).toBe(true);
      // Independent tasks running concurrently safely without cross-delivery
      expect(maxActiveInTurn).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("cancels an in-flight consultation without recording fake completion", async () => {
    const fixture = await createEngineFixture();
    try {
      fixture.setTurnDelay(200);

      const abortController = new AbortController();
      const request: EngineConsultationRequest = {
        anchor: VALID_ANCHOR,
        branch: "main",
        requestedRef: "HEAD",
        taskId: "task-cancel",
        deliveryKey: "delivery-cancel",
        kind: "consult",
        prompt: "Long running question",
        modelId: "gpt-5",
        signal: abortController.signal,
      };

      const submitPromise = fixture.engine.submitSync(request);
      setTimeout(() => abortController.abort(), 20);

      const outcome = await submitPromise;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure).toBe("cancelled");
      expect(outcome.blocked).toBe(false);

      const stored = await fixture.engine.getStatus(jobAddress(outcome.record!));
      expect(stored?.state).toBe("cancelled");
    } finally {
      await fixture.cleanup();
    }
  });

  it("handles browser failure and distinguishes advisory vs required dependency (INV-07)", async () => {
    const fixture = await createEngineFixture();
    try {
      fixture.setNextTurnOutcome({
        ok: false,
        failure: "browser-lost",
      });

      // Advisory consultation: failure is non-blocking (INV-07)
      const advisoryOutcome = await fixture.engine.submitSync({
        anchor: VALID_ANCHOR,
        branch: "main",
        requestedRef: "HEAD",
        taskId: "task-adv",
        deliveryKey: "delivery-adv",
        kind: "consult",
        dependency: "advisory",
        prompt: "Advisory question",
        modelId: "gpt-5",
      });

      expect(advisoryOutcome.ok).toBe(false);
      if (advisoryOutcome.ok) return;
      expect(advisoryOutcome.failure).toBe("browser");
      expect(advisoryOutcome.blocked).toBe(false);

      // Required consultation: failure is reported as blocking
      fixture.setNextTurnOutcome({
        ok: false,
        failure: "needs-human",
      });

      const requiredOutcome = await fixture.engine.submitSync({
        anchor: VALID_ANCHOR,
        branch: "main",
        requestedRef: "HEAD",
        taskId: "task-req",
        deliveryKey: "delivery-req",
        kind: "audit",
        dependency: "required",
        prompt: "Required audit",
        modelId: "gpt-5",
      });

      expect(requiredOutcome.ok).toBe(false);
      if (requiredOutcome.ok) return;
      expect(requiredOutcome.failure).toBe("challenge");
      expect(requiredOutcome.blocked).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});

// --- Test Fixture Helpers ---

async function createEngineFixture(): Promise<{
  engine: ConsultationEngine;
  store: ConsultationJobStore;
  setNextTurnOutcome: (outcome: ConsultationOutcome) => void;
  setTurnDelay: (ms: number, onStart?: () => void, onEnd?: () => void, customWait?: () => Promise<void>) => void;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-engine-test-"));
  const layout = adviserStateLayout(root);
  const store = new ConsultationJobStore(layout);

  let nextTurnOutcome: ConsultationOutcome | undefined;
  let turnDelayMs = 0;
  let onTurnStart: (() => void) | undefined;
  let onTurnEnd: (() => void) | undefined;

  let customWaitFn: (() => Promise<void>) | undefined;

  // In-memory fake Project surface
  const surface: AdviserProjectSurface = {
    listProjects(): Promise<ProjectListResult> {
      return Promise.resolve({ ok: true, projects: [{ projectId: "proj-1", title: `pi-with-chatgpt: ${REPOSITORY}`, projectUrl: "https://chatgpt.com/p/proj-1" }] });
    },
    inspectProject(projectId: string): Promise<ProjectInspection> {
      return Promise.resolve({ state: "present", title: `pi-with-chatgpt: ${REPOSITORY} (${projectId})`, projectUrl: `https://chatgpt.com/p/${projectId}` });
    },
    createProject(input) {
      return Promise.resolve({ ok: true, projectId: "proj-1", title: input.title, projectUrl: "https://chatgpt.com/p/proj-1", instructionsApplied: true });
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

  // Fake browser runtime
  const runtime: AdviserBrowserRuntime = {
    status(): Promise<RuntimeStatus> {
      return Promise.resolve({ phase: "ready", processAlive: true, headed: false, profileDir: root, launchCount: 1, humanAttentionRequired: false });
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
    async consult(_request: ConsultationRequest): Promise<ConsultationOutcome> {
      onTurnStart?.();
      if (customWaitFn) {
        await customWaitFn();
      } else if (turnDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
      }
      onTurnEnd?.();
      if (nextTurnOutcome) {
        const out = nextTurnOutcome;
        nextTurnOutcome = undefined;
        return out;
      }
      return {
        ok: true,
        text: "Adviser answer: consider pattern X.",
        elapsedMs: 50,
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
    maxConcurrentJobs: 3,
  });

  return {
    engine,
    store,
    setNextTurnOutcome: (outcome) => {
      nextTurnOutcome = outcome;
    },
    setTurnDelay: (ms: number, onStart?: () => void, onEnd?: () => void, customWait?: () => Promise<void>) => {
      turnDelayMs = ms;
      onTurnStart = onStart;
      onTurnEnd = onEnd;
      customWaitFn = customWait;
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
