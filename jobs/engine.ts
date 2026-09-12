/**
 * `jobs/engine.ts` — Consultation Execution Engine and Dispatcher (INV-01, INV-04, INV-07, INV-09, INV-15).
 *
 * Orchestrates synchronous and asynchronous consultation jobs:
 * 1. Persists queued job before browser submission (INV-15).
 * 2. Resolves ChatGPT Project and task conversation mapping.
 * 3. Claims job to running with Project/conversation binding and dispatch HEAD.
 * 4. Executes consultation turn on the isolated adviser browser runtime.
 * 5. Serializes turns within the same conversation (INV-09) while permitting independent tasks in parallel.
 * 6. Persists durable response before completing job and before any session wake-up (INV-15).
 * 7. Dispatches asynchronous consultations without blocking the worker, waking only matching Pi sessions (INV-09).
 * 8. Ensures advisory failures do not block worker progress (INV-07).
 */

import type { AdviserProjectSurface, AdviserBrowserRuntime, ConsultationOutcome } from "../browser/runtime-types.js";
import type { AdviserStateLayout } from "../config/state-layout.js";
import { assertCredentialFreeValue } from "../ledger/record.js";
import type { StateStoreFileSystem } from "../ledger/state-store.js";
import { nodeStateStore } from "../ledger/state-store.js";
import type { ConsultationAnchor, ConsultationId } from "../protocol/checkpoint.js";
import type { DependencyMode } from "../protocol/dependency.js";
import type { FullCommitSha } from "../protocol/sha.js";
import { buildProjectInstructions } from "../chatgpt/project-instructions.js";
import { ensureProjectForRepository, type EnsureProjectResult } from "../chatgpt/project-mapping.js";
import { ensureConversationForTask, type EnsureConversationResult } from "../chatgpt/conversation-recovery.js";
import { conversationKeyForTask, type ChatGptConversationKey, type ConsultationKind } from "../chatgpt/scope.js";
import type {
  JobAddress,
  JobResponse,
  ConsultationJobStore,
} from "./store.js";
import { jobAddress } from "./store.js";
import {
  deliveryKeyForSession,
  type JobFailureCode,
  type JobMode,
  type JobRecord,
  type JobResultStatus,
} from "./record.js";

export interface EngineConsultationRequest {
  readonly anchor: ConsultationAnchor;
  readonly branch: string;
  readonly requestedRef?: string;
  readonly optionalPr?: number;
  readonly taskId: string;
  readonly sessionId?: string;
  readonly deliveryKey?: string;
  readonly kind: ConsultationKind;
  readonly dependency?: DependencyMode;
  readonly mode?: JobMode;
  readonly prompt: string;
  readonly modelId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type EngineConsultationOutcome =
  | {
      readonly ok: true;
      readonly record: JobRecord;
      readonly response: JobResponse;
    }
  | {
      readonly ok: false;
      readonly record?: JobRecord;
      readonly failure: JobFailureCode;
      /** When true, a "required" consultation failed, signaling a block; advisory failures do not block. */
      readonly blocked: boolean;
      readonly explanation?: string;
    };

export interface EngineConsultationDispatched {
  readonly consultationId: ConsultationId;
  readonly address: JobAddress;
  readonly state: "queued" | "running";
}

export interface WakeUpNotification {
  readonly address: JobAddress;
  readonly state: JobRecord["state"];
  readonly record?: JobRecord;
  readonly response?: JobResponse;
}

export type WakeUpListener = (notification: WakeUpNotification) => void;

export interface ConsultationEngineDependencies {
  readonly layout: AdviserStateLayout;
  readonly store: ConsultationJobStore;
  readonly surface: AdviserProjectSurface;
  readonly runtime: AdviserBrowserRuntime;
  readonly getHeadCommit: () => Promise<FullCommitSha>;
  readonly fileSystem?: StateStoreFileSystem;
  readonly maxConcurrentJobs?: number;
  readonly now?: () => Date;
}

const DEFAULT_MAX_CONCURRENT_JOBS = 2;

export class ConsultationEngine {
  readonly #layout: AdviserStateLayout;
  readonly #store: ConsultationJobStore;
  readonly #surface: AdviserProjectSurface;
  readonly #runtime: AdviserBrowserRuntime;
  readonly #getHeadCommit: () => Promise<FullCommitSha>;
  readonly #fileSystem: StateStoreFileSystem;
  readonly #maxConcurrentJobs: number;
  readonly #now: () => Date;

  /** Keyed mutex per conversation thread so turns to the same conversation run in sequence (INV-09). */
  readonly #conversationQueues = new Map<ChatGptConversationKey, Promise<void>>();
  /** Concurrency queue to cap maximum active browser consultations across all conversations. */
  #activeJobCount = 0;
  readonly #concurrencyWaiters: (() => void)[] = [];
  /** In-flight cancellations keyed by consultation ID. */
  readonly #inFlightAbortControllers = new Map<ConsultationId, AbortController>();
  /** Registered session wake-up listeners keyed by deliveryKey (Pi session routing digest). */
  readonly #wakeUpListeners = new Map<string, Set<WakeUpListener>>();

  constructor(dependencies: ConsultationEngineDependencies) {
    this.#layout = dependencies.layout;
    this.#store = dependencies.store;
    this.#surface = dependencies.surface;
    this.#runtime = dependencies.runtime;
    this.#getHeadCommit = dependencies.getHeadCommit;
    this.#fileSystem = dependencies.fileSystem ?? nodeStateStore;
    this.#maxConcurrentJobs = dependencies.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
    this.#now = dependencies.now ?? (() => new Date());
  }

  /**
   * Register a wake-up callback for a specific Pi session delivery key (INV-09).
   * Delivery keys are isolated digests so notifications never cross Pi sessions.
   */
  registerWakeUpListener(sessionOrDeliveryKey: string, listener: WakeUpListener): () => void {
    const key = /^[0-9a-f]{64}$/i.test(sessionOrDeliveryKey)
      ? sessionOrDeliveryKey.toLowerCase()
      : deliveryKeyForSession(sessionOrDeliveryKey);
    let set = this.#wakeUpListeners.get(key);
    if (!set) {
      set = new Set();
      this.#wakeUpListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const current = this.#wakeUpListeners.get(key);
      if (current) {
        current.delete(listener);
        if (current.size === 0) this.#wakeUpListeners.delete(key);
      }
    };
  }

  /**
   * Synchronous consultation: submit, wait for adviser turn, persist response, return result.
   */
  async submitSync(request: EngineConsultationRequest): Promise<EngineConsultationOutcome> {
    const dependency = request.dependency ?? "advisory";
    const mode = "sync";
    const deliveryKey = resolveDeliveryKey(request);

    // 1. Create durable queued job before touching the browser (INV-15).
    let record: JobRecord;
    try {
      record = await this.#store.create({
        anchor: request.anchor,
        branch: request.branch,
        taskId: request.taskId,
        deliveryKey,
        kind: request.kind,
        dependency,
        mode,
      });
    } catch {
      return {
        ok: false,
        failure: "browser",
        blocked: dependency === "required",
        explanation: "Failed to persist initial job record.",
      };
    }

    const address = jobAddress(record);
    return await this.#executeJob(record, address, request);
  }

  /**
   * Asynchronous consultation: dispatch in the background, persist state, return immediate handle (INV-09, INV-15).
   */
  async submitAsync(request: EngineConsultationRequest): Promise<EngineConsultationDispatched> {
    const dependency = request.dependency ?? "advisory";
    const mode = "async";
    const deliveryKey = resolveDeliveryKey(request);

    // 1. Create durable queued job before detached dispatch (INV-15).
    const record = await this.#store.create({
      anchor: request.anchor,
      branch: request.branch,
      taskId: request.taskId,
      deliveryKey,
      kind: request.kind,
      dependency,
      mode,
    });

    const address = jobAddress(record);

    // 2. Launch background execution detached from caller await.
    void this.#executeJob(record, address, request).then(
      (outcome) => {
        this.#notifyWakeUp(address, outcome);
      },
      () => {
        // Unexpected rejection in background runner: ensure job is recorded failed.
        void this.#store.fail(address, "browser").then((failedRecord) => {
          this.#notifyWakeUp(address, {
            ok: false,
            record: failedRecord,
            failure: "browser",
            blocked: dependency === "required",
          });
        });
      },
    );

    return {
      consultationId: record.consultationId,
      address,
      state: "queued",
    };
  }

  /**
   * Cancel an in-flight consultation.
   */
  async cancel(address: JobAddress): Promise<JobRecord> {
    const controller = this.#inFlightAbortControllers.get(address.consultationId);
    if (controller) {
      controller.abort();
    }
    const cancelled = await this.#store.cancel(address);
    this.#notifyWakeUp(address, {
      ok: false,
      record: cancelled,
      failure: "cancelled",
      blocked: false,
    });
    return cancelled;
  }

  /**
   * Look up a job record by address.
   */
  async getStatus(address: JobAddress): Promise<JobRecord | undefined> {
    return await this.#store.get(address);
  }

  /**
   * Read persisted response for a consultation.
   */
  async readResult(address: JobAddress): Promise<JobResponse | undefined> {
    return await this.#store.readPersistedResponse(address);
  }

  // --- Internal Execution Pipeline ---

  async #executeJob(
    record: JobRecord,
    address: JobAddress,
    request: EngineConsultationRequest,
  ): Promise<EngineConsultationOutcome> {
    const dependency = record.dependency;
    const abortController = new AbortController();
    this.#inFlightAbortControllers.set(address.consultationId, abortController);

    // Chain caller-provided signal if present.
    if (request.signal) {
      if (request.signal.aborted) {
        abortController.abort();
      } else {
        request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      }
    }

    // Acquire global concurrency slot before starting browser work.
    await this.#acquireConcurrencySlot(abortController.signal);
    if (abortController.signal.aborted) {
      this.#releaseConcurrencySlot();
      this.#inFlightAbortControllers.delete(address.consultationId);
      const cancelledRecord = await this.#store.cancel(address);
      return { ok: false, record: cancelledRecord, failure: "cancelled", blocked: false };
    }

    try {
      // 1. Ensure ChatGPT Project exists and is bound to this repository (INV-08).
      const instructions = buildProjectInstructions({ repository: request.anchor.repository });
      const projectResult: EnsureProjectResult = await ensureProjectForRepository({
        layout: this.#layout,
        repository: request.anchor.repository,
        surface: this.#surface,
        instructions,
        fileSystem: this.#fileSystem,
        now: this.#now,
      });

      if (!projectResult.ok) {
        const failure = mapProjectFailure(projectResult.reason);
        const failedRecord = await this.#store.fail(address, failure);
        return {
          ok: false,
          record: failedRecord,
          failure,
          blocked: dependency === "required",
          explanation: projectResult.explanation,
        };
      }

      const projectId = projectResult.mapping.projectId;

      // 2. Ensure task conversation exists inside this Project (INV-09).
      const conversationScope = {
        repository: request.anchor.repository,
        taskId: request.taskId,
        kind: request.kind,
      };
      const conversationKey = conversationKeyForTask(conversationScope);

      const conversationResult: EnsureConversationResult = await ensureConversationForTask({
        layout: this.#layout,
        surface: this.#surface,
        repository: request.anchor.repository,
        projectId,
        scope: conversationScope,
        fileSystem: this.#fileSystem,
        now: this.#now,
      });

      if (!conversationResult.ok) {
        const failure = mapConversationFailure(conversationResult.reason);
        const failedRecord = await this.#store.fail(address, failure);
        return {
          ok: false,
          record: failedRecord,
          failure,
          blocked: dependency === "required",
          explanation: conversationResult.explanation,
        };
      }

      const conversationId = conversationResult.record.conversationId;

      // 3. Serialize execution within the same conversation key (INV-09).
      return await this.#runInConversationQueue(conversationKey, async () => {
        if (abortController.signal.aborted) {
          const cancelledRecord = await this.#store.cancel(address);
          return { ok: false, record: cancelledRecord, failure: "cancelled", blocked: false };
        }

        // 4. Claim job: transitions queued -> running with Project/conversation and HEAD binding.
        const headAtDispatch = await this.#getHeadCommit();
        const claimResult = await this.#store.claim(address, {
          projectId,
          conversationId,
          headAtDispatch,
        });

        if (!claimResult.claimed) {
          // Already claimed or cancelled
          const current = claimResult.record;
          if (current.state === "cancelled") {
            return { ok: false, record: current, failure: "cancelled", blocked: false };
          }
          if (current.state === "failed") {
            return {
              ok: false,
              record: current,
              failure: current.failure ?? "browser",
              blocked: dependency === "required",
            };
          }
        }

        // 5. Navigate / verify conversation is active on browser tab.
        const inspect = await this.#surface.inspectConversation(conversationId);
        if (inspect.state !== "live") {
          if (inspect.state === "gone") {
            const failedRecord = await this.#store.fail(address, "project");
            return {
              ok: false,
              record: failedRecord,
              failure: "project",
              blocked: dependency === "required",
              explanation: "Conversation was deleted or not found.",
            };
          }
          if (inspect.state === "unknown" && inspect.reason === "needs-human") {
            const failedRecord = await this.#store.fail(address, "challenge");
            return {
              ok: false,
              record: failedRecord,
              failure: "challenge",
              blocked: dependency === "required",
              explanation: "Human verification required on ChatGPT.",
            };
          }
        }

        // 6. Submit brief and await turn on browser runtime.
        if (abortController.signal.aborted) {
          const cancelledRecord = await this.#store.cancel(address);
          return { ok: false, record: cancelledRecord, failure: "cancelled", blocked: false };
        }

        let outcome: ConsultationOutcome;
        try {
          outcome = await this.#runtime.consult({
            consultationId: record.consultationId,
            prompt: request.prompt,
            modelId: request.modelId,
            checkpointSha: request.anchor.resolvedCommit,
            timeoutMs: request.timeoutMs,
          });
        } catch {
          const failedRecord = await this.#store.fail(address, "browser");
          return {
            ok: false,
            record: failedRecord,
            failure: "browser",
            blocked: dependency === "required",
            explanation: "Browser runtime encountered an unexpected error.",
          };
        }

        if (abortController.signal.aborted) {
          const cancelledRecord = await this.#store.cancel(address);
          return { ok: false, record: cancelledRecord, failure: "cancelled", blocked: false };
        }

        if (!outcome.ok) {
          const failure = mapTurnFailure(outcome.failure);
          const failedRecord = await this.#store.fail(address, failure);
          return {
            ok: false,
            record: failedRecord,
            failure,
            blocked: dependency === "required",
            explanation: `Consultation turn failed: ${outcome.failure}`,
          };
        }

        // 7. Success: persist response and mark completed BEFORE wake-up (INV-15).
        assertCredentialFreeValue("engine completed text", outcome.text);
        const headAtReceipt = await this.#getHeadCommit();
        const resultStatus: JobResultStatus = outcome.degraded ? "degraded" : "complete";

        const completedRecord = await this.#store.complete(address, {
          resultStatus,
          headAtReceipt,
          actionItems: [],
          text: outcome.text,
        });

        const persistedResponse = await this.#store.readPersistedResponse(address);
        if (!persistedResponse) {
          const failedRecord = await this.#store.fail(address, "browser");
          return {
            ok: false,
            record: failedRecord,
            failure: "browser",
            blocked: dependency === "required",
            explanation: "Response failed to persist cleanly.",
          };
        }

        return {
          ok: true,
          record: completedRecord,
          response: persistedResponse,
        };
      });
    } finally {
      this.#releaseConcurrencySlot();
      this.#inFlightAbortControllers.delete(address.consultationId);
    }
  }

  async #runInConversationQueue<T>(
    key: ChatGptConversationKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#conversationQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#conversationQueues.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#conversationQueues.get(key) === tail) {
        this.#conversationQueues.delete(key);
      }
    }
  }

  async #acquireConcurrencySlot(signal: AbortSignal): Promise<void> {
    if (this.#activeJobCount < this.#maxConcurrentJobs) {
      this.#activeJobCount += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#concurrencyWaiters.indexOf(onSlotAvailable);
        if (index >= 0) this.#concurrencyWaiters.splice(index, 1);
        reject(new Error("aborted while waiting for concurrency slot"));
      };
      const onSlotAvailable = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#concurrencyWaiters.push(onSlotAvailable);
    });
  }

  #releaseConcurrencySlot(): void {
    const next = this.#concurrencyWaiters.shift();
    if (next) {
      next();
    } else {
      this.#activeJobCount = Math.max(0, this.#activeJobCount - 1);
    }
  }

  #notifyWakeUp(address: JobAddress, outcome: EngineConsultationOutcome): void {
    const listeners = this.#wakeUpListeners.get(address.deliveryKey);
    if (!listeners || listeners.size === 0) return;
    const notification: WakeUpNotification = outcome.ok
      ? { address, state: outcome.record.state, record: outcome.record, response: outcome.response }
      : {
          address,
          state: outcome.record?.state ?? "failed",
          ...(outcome.record ? { record: outcome.record } : {}),
        };
    for (const listener of listeners) {
      try {
        listener(notification);
      } catch {
        // Safe: a broken listener never crashes the engine
      }
    }
  }
}

function mapProjectFailure(reason: string): JobFailureCode {
  switch (reason) {
    case "needs-human":
      return "challenge";
    case "provider-error":
      return "quota";
    case "browser-lost":
      return "browser";
    case "invalid-instructions":
      return "project";
    default:
      return "project";
  }
}

function mapConversationFailure(reason: string): JobFailureCode {
  switch (reason) {
    case "needs-human":
      return "challenge";
    case "provider-error":
      return "quota";
    case "browser-lost":
      return "browser";
    default:
      return "project";
  }
}

function mapTurnFailure(failure: string): JobFailureCode {
  switch (failure) {
    case "needs-human":
      return "challenge";
    case "model-unavailable":
      return "capability";
    case "generation-timeout":
      return "timeout";
    case "browser-lost":
      return "browser";
    case "provider-error":
      return "quota";
    case "composer-missing":
    case "response-unreadable":
      return "browser";
    default:
      return "browser";
  }
}

function resolveDeliveryKey(request: EngineConsultationRequest): string {
  if (request.deliveryKey && /^[0-9a-f]{64}$/i.test(request.deliveryKey)) {
    return request.deliveryKey.toLowerCase();
  }
  const source = request.sessionId ?? request.deliveryKey ?? "default-pi-session";
  return deliveryKeyForSession(source);
}
