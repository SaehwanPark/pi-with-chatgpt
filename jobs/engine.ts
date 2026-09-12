/**
 * `jobs/engine.ts` — Consultation Execution Engine and Dispatcher (INV-01, INV-04, INV-07, INV-09, INV-15).
 *
 * Orchestrates synchronous and asynchronous consultation jobs:
 * 1. Persists queued job before browser submission (INV-15).
 * 2. Resolves ChatGPT Project and task conversation mapping.
 * 3. Claims job to running with Project/conversation binding and dispatch HEAD.
 * 4. Executes consultation turn on the isolated adviser browser runtime.
 * 5. Serializes all browser turns through the single V1 adviser tab (INV-09).
 * 6. Persists durable response before completing job and before any session wake-up (INV-15).
 * 7. Dispatches asynchronous consultations without blocking the worker, waking only matching Pi sessions (INV-09).
 * 8. Ensures advisory failures do not block worker progress (INV-07).
 */

import type { AdviserProjectSurface, AdviserBrowserRuntime, ConsultationOutcome } from "../browser/runtime-types.js";
import { DEFAULT_MODEL_PREFERENCE, resolveModelPreference } from "../browser/model-selection.js";
import type { AdviserStateLayout } from "../config/state-layout.js";
import { assertCredentialFreeValue } from "../ledger/record.js";
import { redactSensitiveText } from "../protocol/masking.js";
import type { StateStoreFileSystem } from "../ledger/state-store.js";
import { nodeStateStore } from "../ledger/state-store.js";
import type { ConsultationAnchor, ConsultationId } from "../protocol/checkpoint.js";
import type { DependencyMode } from "../protocol/dependency.js";
import type { FullCommitSha } from "../protocol/sha.js";
import { parseAdviserResponse } from "../protocol/response.js";
import { ConsultationLedger } from "../ledger/ledger.js";
import { buildProjectInstructions } from "../chatgpt/project-instructions.js";
import { ensureProjectForRepository, type EnsureProjectResult } from "../chatgpt/project-mapping.js";
import { ensureConversationForTask, type EnsureConversationResult } from "../chatgpt/conversation-recovery.js";
import { conversationKeyForTask, type ChatGptConversationKey, type ConsultationKind } from "../chatgpt/scope.js";
import type {
  JobAddress,
  JobResponse,
  JobLookupScope,
  ConsultationJobStore,
} from "./store.js";
import { jobAddress, JobStoreError } from "./store.js";
import {
  deliveryKeyForSession,
  type JobFailureCode,
  type JobMode,
  type JobRecord,
  type JobResultStatus,
} from "./record.js";

export interface EngineConsultationRequest {
  readonly anchor: ConsultationAnchor;
  /** Branch at dispatch time; `null` preserves detached-HEAD provenance. */
  readonly branch: string | null;
  readonly requestedRef?: string;
  readonly optionalPr?: number;
  readonly taskId: string;
  readonly sessionId?: string;
  readonly deliveryKey?: string;
  /** Preallocated once by the extension and carried through brief, job, response, and ledger. */
  readonly consultationId?: ConsultationId;
  readonly kind: ConsultationKind;
  readonly dependency?: DependencyMode;
  readonly mode?: JobMode;
  readonly prompt: string;
  /** A legacy/resolved model id. Prefer `modelPreference` for live selection. */
  readonly modelId?: string;
  /** Ranked model preference resolved against the live ChatGPT picker before submission. */
  readonly modelPreference?: readonly string[];
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
  readonly ledger?: ConsultationLedger;
  readonly fileSystem?: StateStoreFileSystem;
  readonly maxConcurrentJobs?: number;
  readonly now?: () => Date;
}

/**
 * V1 owns one tracked adviser tab. Project/conversation navigation and the eventual turn submission
 * share that tab, so independent jobs cannot safely overlap even when their conversations differ. Keep
 * the browser transaction serial until the runtime grows a conversation-scoped page/atomic operation.
 */
const DEFAULT_MAX_CONCURRENT_JOBS = 1;

export class ConsultationEngine {
  readonly #layout: AdviserStateLayout;
  readonly #store: ConsultationJobStore;
  readonly #surface: AdviserProjectSurface;
  readonly #runtime: AdviserBrowserRuntime;
  readonly #getHeadCommit: () => Promise<FullCommitSha>;
  readonly #ledger: ConsultationLedger;
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
  /** Detached executions, retained so cancellation can wait for a bounded cleanup point. */
  readonly #inFlightExecutions = new Map<ConsultationId, Promise<EngineConsultationOutcome>>();
  /** Registered session wake-up listeners keyed by deliveryKey (Pi session routing digest). */
  readonly #wakeUpListeners = new Map<string, Set<WakeUpListener>>();

  constructor(dependencies: ConsultationEngineDependencies) {
    this.#layout = dependencies.layout;
    this.#store = dependencies.store;
    this.#surface = dependencies.surface;
    this.#runtime = dependencies.runtime;
    this.#getHeadCommit = dependencies.getHeadCommit;
    this.#fileSystem = dependencies.fileSystem ?? nodeStateStore;
    // The option remains injectable for compatibility with callers and tests, but never permits a
    // second browser consultation in V1. A caller-provided value greater than one would reintroduce the
    // inspect/navigation/send race described by INV-09 because the runtime consult API has no conversation
    // address.
    this.#maxConcurrentJobs = Math.max(
      1,
      Math.min(dependencies.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS, DEFAULT_MAX_CONCURRENT_JOBS),
    );
    this.#now = dependencies.now ?? (() => new Date());
    this.#ledger =
      dependencies.ledger ??
      new ConsultationLedger({
        layout: this.#layout,
        fileSystem: this.#fileSystem,
        now: () => this.#now().getTime(),
      });
  }

  get ledger(): ConsultationLedger {
    return this.#ledger;
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
        consultationId: request.consultationId,
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
    const execution = this.#executeJob(record, address, request);
    this.#inFlightExecutions.set(address.consultationId, execution);
    try {
      return await execution;
    } finally {
      if (this.#inFlightExecutions.get(address.consultationId) === execution) {
        this.#inFlightExecutions.delete(address.consultationId);
      }
    }
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
      consultationId: request.consultationId,
      kind: request.kind,
      dependency,
      mode,
    });

    const address = jobAddress(record);

    // 2. Launch background execution detached from caller await. Keep the promise indexed so a cancel
    // request can wait for the runner to observe the abort and release its lock/slot before returning.
    const execution = this.#executeJob(record, address, request);
    this.#inFlightExecutions.set(address.consultationId, execution);
    void execution.then(
      (outcome) => {
        this.#notifyWakeUp(address, outcome);
      },
      () => {
        // Unexpected rejection in background runner: ensure job is recorded failed.
        void this.#failJob(address, "browser").then((failedRecord) => {
          if (failedRecord.state === "failed") {
            this.#notifyWakeUp(address, {
              ok: false,
              record: failedRecord,
              failure: "browser",
              blocked: dependency === "required",
            });
          }
        }).catch(() => undefined);
      },
    ).finally(() => {
      if (this.#inFlightExecutions.get(address.consultationId) === execution) {
        this.#inFlightExecutions.delete(address.consultationId);
      }
    });

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
    const execution = this.#inFlightExecutions.get(address.consultationId);
    if (controller) {
      controller.abort();
    }
    const cancelled = await this.#cancelJob(address);
    // A detached runner will publish the terminal notification once it has unwound. Avoid a duplicate
    // wake-up here, while still notifying for a queued job that has no runner (for example after restart).
    if (cancelled.state === "cancelled" && execution === undefined) {
      this.#notifyWakeUp(address, {
        ok: false,
        record: cancelled,
        failure: "cancelled",
        blocked: false,
      });
    }
    if (execution !== undefined) {
      // Browser APIs do not all accept AbortSignal yet. Give the runner a short, bounded grace period to
      // release local state; cancellation itself is already durable and never waits for a full provider
      // timeout. A late completion cannot overwrite the cancelled terminal record.
      await Promise.race([
        execution.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    return (await this.#store.get(address).catch(() => undefined)) ?? cancelled;
  }

  /** Resolve and cancel the durable job by consultation ID; never synthesize a JobAddress. */
  async cancelByConsultationId(
    consultationId: ConsultationId,
    scope: JobLookupScope = {},
  ): Promise<JobRecord> {
    const record = await this.#store.getByConsultationId(consultationId, scope);
    if (record === undefined) throw new JobStoreError("job-missing");
    return this.cancel(jobAddress(record));
  }

  /**
   * Look up a job record by address.
   */
  async getStatus(address: JobAddress): Promise<JobRecord | undefined> {
    return await this.#store.get(address);
  }

  /** Status lookup for UI callers that only have a consultation ID. */
  async getStatusByConsultationId(
    consultationId: ConsultationId,
    scope: JobLookupScope = {},
  ): Promise<JobRecord | undefined> {
    return await this.#store.getByConsultationId(consultationId, scope);
  }

  /** List live and terminal job records for status projections. */
  async listStatus(options: { readonly states?: readonly JobRecord["state"][] } = {}): Promise<readonly JobRecord[]> {
    return await this.#store.list(options);
  }

  /** Reconcile dead-process jobs once at service startup; ambiguous browser turns are not replayed. */
  async reconcile(): Promise<readonly JobRecord[]> {
    const records = await this.#store.reconcileRunningJobs();
    for (const record of records) {
      await this.#recordTerminalLedger(record);
    }
    return records;
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

    let concurrencySlotAcquired = false;
    try {
      // Acquire global concurrency slot before starting browser work. Cancellation while waiting
      // must settle as cancelled, not as an unrelated browser failure.
      try {
        await this.#acquireConcurrencySlot(abortController.signal);
        concurrencySlotAcquired = true;
      } catch (error) {
        if (!abortController.signal.aborted) throw error;
        return await this.#cancelOutcome(address, dependency);
      }
      if (abortController.signal.aborted) {
        return await this.#cancelOutcome(address, dependency);
      }

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
        const failedRecord = await this.#failJob(address, failure);
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
        const failedRecord = await this.#failJob(address, failure);
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
          return await this.#cancelOutcome(address, dependency);
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
            const failedRecord = await this.#failJob(address, "project");
            return {
              ok: false,
              record: failedRecord,
              failure: "project",
              blocked: dependency === "required",
              explanation: "Conversation was deleted or not found.",
            };
          }
          if (inspect.state === "unknown" && inspect.reason === "needs-human") {
            const failedRecord = await this.#failJob(address, "challenge");
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
          return await this.#cancelOutcome(address, dependency);
        }

        const modelSelection = await this.#resolveModel(request);
        if (!modelSelection.ok) {
          const failedRecord = await this.#failJob(address, "capability");
          return {
            ok: false,
            record: failedRecord,
            failure: "capability",
            blocked: dependency === "required",
            explanation: modelSelection.explanation,
          };
        }

        let outcome: ConsultationOutcome;
        try {
          outcome = await this.#runtime.consult({
            consultationId: record.consultationId,
            prompt: request.prompt,
            modelId: modelSelection.modelId,
            checkpointSha: request.anchor.resolvedCommit,
            timeoutMs: request.timeoutMs,
          });
        } catch {
          const failedRecord = await this.#failJob(address, "browser");
          return {
            ok: false,
            record: failedRecord,
            failure: "browser",
            blocked: dependency === "required",
            explanation: "Browser runtime encountered an unexpected error.",
          };
        }

        if (abortController.signal.aborted) {
          return await this.#cancelOutcome(address, dependency);
        }

        if (outcome.ok && modelSelection.degraded) {
          outcome = {
            ...outcome,
            degraded: modelSelection.reason ?? "model preference fallback",
          };
        }

        if (!outcome.ok) {
          const failure = mapTurnFailure(outcome.failure);
          const failedRecord = await this.#failJob(address, failure);
          return {
            ok: false,
            record: failedRecord,
            failure,
            blocked: dependency === "required",
            explanation: `Consultation turn failed: ${outcome.failure}`,
          };
        }

        // 7. Success: sanitize repository-derived examples before persistence. The adviser may quote
        // a fake token from a test/security document; rejecting the whole answer loses useful advice,
        // while writing it verbatim would violate credential containment (INV-12).
        const sanitizedResponse = redactSensitiveText(outcome.text);
        const safeResponseText = sanitizedResponse.text;
        assertCredentialFreeValue("engine completed text", safeResponseText);
        const headAtReceipt = await this.#getHeadCommit();
        const parsed = parseAdviserResponse(safeResponseText, {
          expectedCommitSha: request.anchor.resolvedCommit,
          expectedConsultationId: record.consultationId,
        });
        const parsingNotes = sanitizedResponse.redacted
          ? [...parsed.parsingNotes, "Sensitive-looking text was redacted before persistence."]
          : parsed.parsingNotes;
        // A transport/model degradation never repairs a provenance failure. If the response belongs to
        // another consultation (or omits identity), preserve the stronger ambiguity signal even when
        // the runtime also reports a fallback/degraded turn.
        const resultStatus: JobResultStatus = parsed.resultStatus === "provenance-ambiguous"
          ? parsed.resultStatus
          : outcome.degraded
            ? "degraded"
            : parsed.resultStatus;

        const actionItems = parsed.actionItems.map((item) => ({
          id: item.id,
          summary: item.summary,
        }));

        const completedRecord = await this.#store.complete(address, {
          resultStatus,
          headAtReceipt,
          actionItems,
          text: safeResponseText,
        });

        // Record into persistent repository ledger (INV-15)
        try {
          await this.#ledger.recordConsultation(
            {
              schemaVersion: 1,
              consultationId: record.consultationId,
              taskId: record.taskId,
              repository: request.anchor.repository,
              branch: record.branch,
              requestedRef: request.anchor.requestedRef,
              resolvedCommit: request.anchor.resolvedCommit,
              reviewedCommit: parsed.reviewedCommit,
              headAtDispatch,
              headAtReceipt,
              prNumber: request.anchor.pullRequest?.number,
              kind: record.kind,
              dependency: record.dependency,
              projectId,
              conversationId,
              status: "completed",
              resultStatus,
              actionItems: parsed.actionItems.map((item) => ({
                id: item.id,
                summary: item.summary,
                disposition: "pending",
              })),
              createdAt: record.createdAt,
              completedAt: completedRecord.finishedAt ?? new Date(this.#now()).toISOString(),
              provenanceNotes: parsingNotes,
            },
            safeResponseText,
          );
        } catch {
          // Ledger recording failure is non-fatal if store write succeeded
        }

        const persistedResponse = await this.#store.readPersistedResponse(address);
        if (!persistedResponse) {
          const failedRecord = await this.#failJob(address, "browser");
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
    } catch {
      // Any unexpected project/conversation/receipt exception still gets a durable terminal
      // outcome. Do not expose provider or filesystem exception text to the worker.
      try {
        const failedRecord = await this.#failJob(address, "browser");
        if (failedRecord.state === "cancelled") {
          return { ok: false, record: failedRecord, failure: "cancelled", blocked: false };
        }
        return {
          ok: false,
          record: failedRecord,
          failure: failedRecord.failure ?? "browser",
          blocked: dependency === "required",
          explanation: "Consultation pipeline encountered an unexpected error.",
        };
      } catch {
        return {
          ok: false,
          failure: "browser",
          blocked: dependency === "required",
          explanation: "Consultation pipeline encountered an unexpected error.",
        };
      }
    } finally {
      if (concurrencySlotAcquired) this.#releaseConcurrencySlot();
      this.#inFlightAbortControllers.delete(address.consultationId);
    }
  }

  async #failJob(address: JobAddress, failure: JobFailureCode): Promise<JobRecord> {
    const failed = await this.#store.fail(address, failure);
    await this.#recordTerminalLedger(failed);
    return failed;
  }

  async #cancelJob(address: JobAddress): Promise<JobRecord> {
    const cancelled = await this.#store.cancel(address);
    await this.#recordTerminalLedger(cancelled);
    return cancelled;
  }

  async #cancelOutcome(address: JobAddress, dependency: DependencyMode): Promise<EngineConsultationOutcome> {
    const record = await this.#cancelJob(address);
    // If completion won the terminal race, preserve that durable result rather than reporting a
    // cancellation that did not take effect.
    if (record.state === "completed") {
      const response = await this.#store.readPersistedResponse(address).catch(() => undefined);
      if (response !== undefined) return { ok: true, record, response };
    }
    const failure = record.state === "failed" ? record.failure ?? "browser" : "cancelled";
    return {
      ok: false,
      record,
      failure,
      blocked: failure !== "cancelled" && dependency === "required",
    };
  }

  async #recordTerminalLedger(record: JobRecord): Promise<void> {
    if (record.state !== "completed" && record.state !== "failed" && record.state !== "cancelled") return;
    try {
      await this.#ledger.recordTerminalJob({ record });
    } catch {
      // The job store remains operational truth; a ledger outage must not block local work.
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

  /** Resolve the requested preference against the account's current selectable models. */
  async #resolveModel(request: EngineConsultationRequest): Promise<
    | { readonly ok: true; readonly modelId: string; readonly degraded: boolean; readonly reason?: string }
    | { readonly ok: false; readonly explanation: string }
  > {
    let discovered: Awaited<ReturnType<AdviserBrowserRuntime["discoverModels"]>>;
    try {
      discovered = await this.#runtime.discoverModels();
    } catch {
      return { ok: false, explanation: "Unable to inspect available adviser models." };
    }
    if (!discovered.ok || discovered.models === undefined) {
      return {
        ok: false,
        explanation: `Unable to resolve adviser model preference (${discovered.rejection ?? "model list unavailable"}).`,
      };
    }

    const preference = request.modelPreference ?? (request.modelId === undefined ? DEFAULT_MODEL_PREFERENCE : [request.modelId]);
    const selection = resolveModelPreference(preference, discovered.models);
    if (!selection.ok) {
      return {
        ok: false,
        explanation: `No selectable adviser model (${selection.reason}).`,
      };
    }
    return {
      ok: true,
      modelId: selection.model.modelId,
      degraded: selection.degraded,
      ...(selection.reason === undefined ? {} : { reason: selection.reason }),
    };
  }

  async #acquireConcurrencySlot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("aborted while waiting for concurrency slot");
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
        const index = this.#concurrencyWaiters.indexOf(onSlotAvailable);
        if (index >= 0) this.#concurrencyWaiters.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        this.#activeJobCount += 1;
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
