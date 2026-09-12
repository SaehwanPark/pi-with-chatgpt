/**
 * `extension/tools.ts` — Agent-facing tools for the Pi worker model (INV-01, INV-13).
 *
 * Implements 8 tools:
 * - advisor_preflight
 * - advisor_submit
 * - advisor_read
 * - advisor_status
 * - advisor_followup
 * - advisor_cancel
 * - advisor_auth
 * - advisor_disposition
 */

import { getPiSessionId, isPiProjectTrusted, type AdviserExtensionContext, type AdviserToolDefinition } from "./pi-api.js";
import { type AdviserConfig, DEFAULT_CONFIG } from "../config/schema.js";
import type { ConsultationKind } from "../protocol/brief.js";
import { buildConsultationBrief, CONSULTATION_KINDS } from "../protocol/brief.js";
import { ConsultationLedger, type ActionItemDisposition } from "../ledger/ledger.js";
import { isConsultationId, type ConsultationId } from "../protocol/checkpoint.js";
import { toWorkerFacingAdvisory, type WorkerFacingAdvisory } from "../ui/worker-facing.js";
import {
  classifyAdviceStatus,
  analyzeGraphDrift,
  analyzeFileDrift,
  extractMentionedFiles,
  buildFollowUpBrief,
  recordActionItemDisposition,
  adviceCurrencyFor,
} from "../drift/index.js";
import { adviserStatus } from "../auth/status.js";
import type { AdviserLoginPort } from "../auth/login-flow.js";
import { resolveCheckpoint } from "../git/checkpoint-resolution.js";
import { createGitExecutor, createNodeCommandRunner, type GitExecutor } from "../git/exec.js";
import type { GitHubApi } from "../git/github-api.js";
import { createGitHubApi } from "../git/github-api.js";
import { adviserStateLayout } from "../config/state-layout.js";
import { adviserProfileFor, stateStoragePaths } from "../browser/state-storage.js";
import type { ConsultationEngine } from "../jobs/engine.js";
import { generateConsultationId } from "../jobs/record.js";
import { DEFAULT_MODEL_PREFERENCE } from "../browser/model-selection.js";

export interface ToolServiceOptions {
  readonly config?: AdviserConfig;
  /** Lazy loader for global/project configuration; activation remains side-effect free. */
  readonly configFactory?: (cwd: string) => Promise<AdviserConfig>;
  readonly git?: GitExecutor;
  readonly github?: GitHubApi;
  readonly ledger?: ConsultationLedger;
  readonly engine?: ConsultationEngine;
  /** Lazy production composition; test fixtures may inject an engine directly instead. */
  readonly engineFactory?: (cwd: string) => Promise<ConsultationEngine>;
  /** Optional browser observer used to distinguish Pi OAuth from current ChatGPT web readiness. */
  readonly loginPort?: AdviserLoginPort;
  /** Lazy production login adapter over the extension-owned browser profile. */
  readonly loginPortFactory?: (cwd: string) => Promise<AdviserLoginPort>;
  /** Ranked adviser model preferences; resolved against the live ChatGPT model picker by the engine. */
  readonly modelPreference?: readonly string[];
}

function defaultGitHubApi(): GitHubApi {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  try {
    return createGitHubApi({
      fetchImpl: globalThis.fetch as unknown as Parameters<typeof createGitHubApi>[0]["fetchImpl"],
      ...(token.trim().length === 0 ? {} : { token }),
    });
  } catch {
    // A missing fetch implementation is an honest unavailable probe, never proof that a commit exists.
  }
  return {
    checkCommitPresence() {
      return Promise.resolve({
        ok: false,
        failure: { reason: "network-unreachable" as const, detail: "GitHub API client unavailable." },
      });
    },
    listOpenPullRequestsForHead() {
      return Promise.resolve({
        ok: false,
        failure: { reason: "network-unreachable" as const, detail: "GitHub API client unavailable." },
      });
    },
  };
}

export class ToolManager {
  private readonly config: AdviserConfig;
  private readonly configFactory?: (cwd: string) => Promise<AdviserConfig>;
  private readonly git: GitExecutor;
  private readonly github: GitHubApi;
  private readonly ledger: ConsultationLedger;
  private readonly engine?: ConsultationEngine;
  private readonly engineFactory?: (cwd: string) => Promise<ConsultationEngine>;
  private readonly loginPort?: AdviserLoginPort;
  private readonly loginPortFactory?: (cwd: string) => Promise<AdviserLoginPort>;
  private readonly modelPreference: readonly string[];

  constructor(options: ToolServiceOptions = {}) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.configFactory = options.configFactory;
    this.git = options.git ?? createGitExecutor(createNodeCommandRunner());
    this.github = options.github ?? defaultGitHubApi();
    if (options.ledger) {
      this.ledger = options.ledger;
    } else {
      const paths = stateStoragePaths();
      const layout = adviserStateLayout(paths.stateRoot);
      this.ledger = new ConsultationLedger({ layout });
    }
    this.engine = options.engine;
    this.engineFactory = options.engineFactory;
    this.loginPort = options.loginPort;
    this.loginPortFactory = options.loginPortFactory;
    this.modelPreference = options.modelPreference ?? DEFAULT_MODEL_PREFERENCE;
  }

  private async resolveEngine(cwd: string): Promise<ConsultationEngine | undefined> {
    if (this.engine) return this.engine;
    if (this.engineFactory) return await this.engineFactory(cwd);
    return undefined;
  }

  private async resolveLoginPort(cwd: string): Promise<AdviserLoginPort | undefined> {
    if (this.loginPort) return this.loginPort;
    if (this.loginPortFactory) return await this.loginPortFactory(cwd);
    return undefined;
  }

  private async resolveConfig(cwd: string): Promise<AdviserConfig> {
    if (!this.configFactory) return this.config;
    try {
      return await this.configFactory(cwd);
    } catch {
      return this.config;
    }
  }

  getTools(): readonly AdviserToolDefinition[] {
    return [
      this.createPreflightTool(),
      this.createSubmitTool(),
      this.createReadTool(),
      this.createStatusTool(),
      this.createFollowUpTool(),
      this.createCancelTool(),
      this.createAuthTool(),
      this.createDispositionTool(),
    ];
  }

  private createPreflightTool(): AdviserToolDefinition {
    return {
      name: "advisor_preflight",
      description: "Perform read-only preflight verification of git anchor and GitHub remote reachability",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory (defaults to current)" },
        },
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const cwd = (params as Record<string, unknown>)?.cwd as string | undefined ?? ctx?.cwd ?? process.cwd();
        const config = await this.resolveConfig(cwd);
        if (!config.enabled) {
          return {
            content: [{ type: "text", text: "Adviser consultations are disabled by configuration." }],
            details: { ready: false, reason: "disabled" },
          };
        }
        if (!isPiProjectTrusted(ctx)) {
          return {
            content: [{ type: "text", text: "Preflight refused: Pi does not trust this project." }],
            details: { ready: false, reason: "project-untrusted" },
          };
        }
        const checkpointRes = await resolveCheckpoint({
          git: this.git,
          github: this.github,
          cwd,
          requestedRef: "HEAD",
        });

        if (!checkpointRes.ok) {
          return {
            content: [{
              type: "text",
              text: `Preflight refused at stage ${checkpointRes.refusal.stage}: ${checkpointRes.refusal.explanation}`,
            }],
            details: {
              ready: false,
              stage: checkpointRes.refusal.stage,
              reason: checkpointRes.refusal.reason,
              explanation: checkpointRes.refusal.explanation,
            },
          };
        }

        const { anchor, readiness } = checkpointRes.resolved;
        return {
          content: [{
            type: "text",
            text: `Preflight verification for ${anchor.repository} at ${anchor.resolvedCommit.slice(0, 7)}: ready=${readiness.ready}`,
          }],
          details: {
            ready: readiness.ready,
            repository: anchor.repository,
            checkpointCommit: anchor.resolvedCommit,
            remoteAvailability: anchor.remoteAvailability,
            readiness,
          },
        };
      },
    };
  }

  private createSubmitTool(): AdviserToolDefinition {
    return {
      name: "advisor_submit",
      description: "Submit a new consultation request to the ChatGPT adviser (INV-01, INV-13)",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [...CONSULTATION_KINDS],
            description: "Consultation kind (consult, plan, review, audit, debug, challenge)",
          },
          goal: { type: "string", description: "Primary goal or question for the consultation" },
          cwd: { type: "string", description: "Working directory (defaults to current)" },
          taskId: { type: "string", description: "Task identifier for conversation isolation" },
        },
        required: ["kind", "goal"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const rawParams = params as Record<string, unknown>;
        const kind = (rawParams?.kind as ConsultationKind) || "consult";
        const goal = (rawParams?.goal as string) || "";
        const cwd = (rawParams?.cwd as string | undefined) ?? ctx?.cwd ?? process.cwd();
        const requestedTaskId = rawParams?.taskId as string | undefined;
        const config = await this.resolveConfig(cwd);
        if (!config.enabled) {
          return {
            content: [{ type: "text", text: "Consultation submission refused: adviser consultations are disabled by configuration." }],
            details: { ok: false, failure: "disabled" },
          };
        }
        if (!isPiProjectTrusted(ctx)) {
          return {
            content: [{ type: "text", text: "Consultation submission refused: Pi does not trust this project." }],
            details: { ok: false, failure: "project-untrusted" },
          };
        }
        let taskId: string;
        let sessionId: string | undefined;
        try {
          sessionId = getPiSessionId(ctx as AdviserExtensionContext);
          taskId = requestedTaskId ?? sessionId;
        } catch (err) {
          if (requestedTaskId !== undefined) {
            taskId = requestedTaskId;
          } else {
            return {
              content: [{ type: "text", text: `Consultation submission refused: ${err instanceof Error ? err.message : String(err)}` }],
              details: {
                ok: false,
                failure: "session-unavailable",
                explanation: "A real Pi session identity is required when taskId is not supplied.",
              },
            };
          }
        }
        if (taskId === undefined) {
          return {
            content: [{ type: "text", text: "Consultation submission refused: taskId is required." }],
            details: {
              ok: false,
              failure: "task-unavailable",
              explanation: "A task identifier could not be resolved.",
            },
          };
        }

        const checkpointRes = await resolveCheckpoint({
          git: this.git,
          github: this.github,
          cwd,
          requestedRef: "HEAD",
        });
        if (!checkpointRes.ok) {
          return {
            content: [{
              type: "text",
              text: `Consultation submission refused (${checkpointRes.refusal.stage}): ${checkpointRes.refusal.explanation}`,
            }],
            details: {
              ok: false,
              failure: "checkpoint-refusal",
              stage: checkpointRes.refusal.stage,
              explanation: checkpointRes.refusal.explanation,
            },
          };
        }

        const { anchor, workingState } = checkpointRes.resolved;
        const consultationId = generateConsultationId();

        const brief = buildConsultationBrief({
          consultationId,
          kind,
          repository: anchor.repository,
          branch: workingState.branch ?? null,
          checkpointSha: anchor.resolvedCommit,
          prNumber: anchor.pullRequest?.number,
          goal,
          question: `Provide actionable guidance and recommendations for this ${kind} consultation.`,
        });

        const engine = await this.resolveEngine(cwd).catch(() => undefined);
        if (engine) {
          try {
            if (config.defaultMode === "async") {
              const dispatched = await engine.submitAsync({
                anchor,
                branch: workingState.branch ?? null,
                taskId,
                ...(sessionId === undefined ? {} : { sessionId }),
                kind,
                dependency: config.dependencyDefault,
                mode: "async",
                prompt: brief,
                consultationId,
                modelPreference: this.modelPreference,
              });
              return {
                content: [{
                  type: "text",
                  text: `Consultation ${dispatched.consultationId} queued for asynchronous delivery.`,
                }],
                details: {
                  ok: true,
                  consultationId: dispatched.consultationId,
                  state: dispatched.state,
                  mode: "async",
                },
              };
            }

            const turnResult = await engine.submitSync({
              anchor,
              branch: workingState.branch ?? null,
              taskId,
              ...(sessionId === undefined ? {} : { sessionId }),
              kind,
              dependency: config.dependencyDefault,
              mode: "sync",
              prompt: brief,
              consultationId,
              modelPreference: this.modelPreference,
              timeoutMs: config.syncTimeoutMs,
            });

            if (turnResult.ok) {
              const entries = await this.ledger.list({ repository: anchor.repository });
              const record = entries.find((e) => e.consultationId === turnResult.record.consultationId);
              let advisory: WorkerFacingAdvisory;
              if (record) {
                const responseText = await this.ledger.readResponse(record.consultationId, anchor.repository);
                advisory = { ...toWorkerFacingAdvisory(record), advice: responseText ?? turnResult.response.text };
              } else {
                advisory = {
                  consultationId: turnResult.record.consultationId,
                  kind,
                  state: "completed",
                  dependency: config.dependencyDefault,
                  checkpoint: {
                    requestedRef: anchor.requestedRef,
                    resolvedCommit: anchor.resolvedCommit,
                  },
                  advice: turnResult.response.text,
                  actionItems: [],
                };
              }

              return {
                content: [{
                  type: "text",
                  text: `Consultation ${turnResult.record.consultationId} (${kind}) submitted and recorded at ${anchor.resolvedCommit.slice(0, 7)}.`,
                }],
                details: {
                  ok: true,
                  consultationId: turnResult.record.consultationId,
                  advisory,
                },
              };
            }

            return {
              content: [{
                type: "text",
                text: `Consultation ${consultationId} failed: ${turnResult.failure}.`,
              }],
              details: {
                ok: false,
                consultationId,
                failure: turnResult.failure,
                blocked: turnResult.blocked,
                explanation: turnResult.explanation,
              },
            };
          } catch (err) {
            return {
              content: [{
                type: "text",
                text: `Consultation error: ${err instanceof Error ? err.message : String(err)}`,
              }],
              details: {
                ok: false,
                consultationId,
                failure: "execution-error",
                error: err instanceof Error ? err.message : String(err),
              },
            };
          }
        }

        return {
          content: [{
            type: "text",
            text: `Consultation ${consultationId} could not start: adviser engine unavailable.`,
          }],
          details: {
            ok: false,
            consultationId,
            failure: "engine-unavailable",
            explanation: "The production adviser service is not configured or could not be initialized.",
          },
        };
      },
    };
  }

  private createReadTool(): AdviserToolDefinition {
    return {
      name: "advisor_read",
      description: "Read full advisory and worker-facing representation of a consultation (INV-13)",
      parameters: {
        type: "object",
        properties: {
          consultationId: { type: "string", description: "Consultation identifier" },
          cwd: { type: "string", description: "Working directory" },
        },
        required: ["consultationId"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const rawParams = params as Record<string, unknown>;
        const consultationId = rawParams?.consultationId as ConsultationId;
        const cwd = (rawParams?.cwd as string | undefined) ?? ctx?.cwd ?? process.cwd();

        const checkpointRes = await resolveCheckpoint({
          git: this.git,
          github: this.github,
          cwd,
          requestedRef: "HEAD",
        });
        if (!checkpointRes.ok) {
          return {
            content: [{ type: "text", text: `Checkpoint error: ${checkpointRes.refusal.explanation}` }],
            details: { ok: false, error: checkpointRes.refusal.explanation },
          };
        }

        const { anchor } = checkpointRes.resolved;
        const entries = await this.ledger.list({ repository: anchor.repository });
        const record = entries.find((e) => e.consultationId === consultationId);
        if (!record) {
          return {
            content: [{ type: "text", text: `Consultation ${consultationId} not found.` }],
            details: { ok: false, error: `Consultation ${consultationId} not found.` },
          };
        }

        const responseMarkdown = await this.ledger.readResponse(record.consultationId, anchor.repository);
        const advisory = toWorkerFacingAdvisory(record);

        return {
          content: [{
            type: "text",
            text: `Advisory for ${record.kind} (${record.consultationId}):\n\n${responseMarkdown ?? ""}`,
          }],
          details: {
            ok: true,
            consultationId: record.consultationId,
            kind: record.kind,
            advisory: {
              ...advisory,
              advice: responseMarkdown,
            },
          },
        };
      },
    };
  }

  private createStatusTool(): AdviserToolDefinition {
    return {
      name: "advisor_status",
      description: "Check status and drift of a consultation against current HEAD (INV-01, INV-05)",
      parameters: {
        type: "object",
        properties: {
          consultationId: { type: "string", description: "Consultation ID (optional; defaults to latest)" },
          cwd: { type: "string", description: "Working directory" },
        },
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const rawParams = params as Record<string, unknown>;
        const consultationId = rawParams?.consultationId as string | undefined;
        const cwd = (rawParams?.cwd as string | undefined) ?? ctx?.cwd ?? process.cwd();

        const checkpointRes = await resolveCheckpoint({
          git: this.git,
          github: this.github,
          cwd,
          requestedRef: "HEAD",
        });
        if (!checkpointRes.ok) {
          return {
            content: [{ type: "text", text: `Checkpoint error: ${checkpointRes.refusal.explanation}` }],
            details: { ok: false, error: checkpointRes.refusal.explanation },
          };
        }

        const { anchor } = checkpointRes.resolved;

        if (consultationId) {
          // JobStore is the live authority; consult it before terminal ledger history so a
          // queued/running job survives a Pi crash in the status surface.
          const engine = await this.resolveEngine(cwd).catch(() => undefined);
          const live = engine && typeof engine.getStatusByConsultationId === "function"
            ? await engine.getStatusByConsultationId(consultationId as ConsultationId, {
                repository: anchor.repository,
              }).catch(() => undefined)
            : undefined;
          if (live && live.state !== "completed" && live.state !== "failed" && live.state !== "cancelled") {
            return {
              content: [{ type: "text", text: `Consultation ${live.consultationId}: kind=${live.kind} status=${live.state}` }],
              details: {
                ok: true,
                consultationId: live.consultationId,
                kind: live.kind,
                status: live.state,
                checkpointCommit: live.anchor.resolvedCommit,
              },
            };
          }
          const entries = await this.ledger.list({ repository: anchor.repository });
          const record = entries.find((e) => e.consultationId === consultationId);
          if (!record) {
            if (live) {
              return {
                content: [{ type: "text", text: `Consultation ${live.consultationId}: kind=${live.kind} status=${live.state}` }],
                details: {
                  ok: true,
                  consultationId: live.consultationId,
                  kind: live.kind,
                  status: live.state,
                  checkpointCommit: live.anchor.resolvedCommit,
                },
              };
            }
            return {
              content: [{ type: "text", text: `Consultation ${consultationId} not found.` }],
              details: { ok: false, error: `Consultation ${consultationId} not found.` },
            };
          }

          let driftResult = undefined;
          try {
            const graph = await analyzeGraphDrift({
              git: this.git,
              cwd,
              checkpoint: record.resolvedCommit,
              currentHead: anchor.resolvedCommit,
            });
            const adviceText = await this.ledger.readResponse(record.consultationId, anchor.repository);
            const actionItemSummaries = record.actionItems.map((a) => a.summary);
            const mentionedFiles = extractMentionedFiles(adviceText ?? "", actionItemSummaries);
            const fileDrift = await analyzeFileDrift({
              git: this.git,
              cwd,
              checkpoint: record.resolvedCommit,
              currentHead: anchor.resolvedCommit,
              mentionedFiles,
            });
            const report = classifyAdviceStatus(graph, fileDrift, record.actionItems);
            driftResult = {
              classification: report.classification,
              verdict: graph.verdict,
              currency: adviceCurrencyFor(graph.verdict),
              summaryNote: report.summaryNote,
              affectedActionItemIds: report.affectedActionItemIds,
            };
          } catch {
            // non-blocking
          }

          return {
            content: [{
              type: "text",
              text: `Consultation ${record.consultationId}: kind=${record.kind} status=${record.status}${driftResult ? ` drift=${driftResult.classification}` : ""}`,
            }],
            details: {
              ok: true,
              consultationId: record.consultationId,
              kind: record.kind,
              status: record.status,
              checkpointCommit: record.resolvedCommit,
              currentHead: anchor.resolvedCommit,
              drift: driftResult,
            },
          };
        }

        const recent = await this.ledger.list({ repository: anchor.repository, limit: 10 });
        const engine = await this.resolveEngine(cwd).catch(() => undefined);
        const live = engine && typeof engine.listStatus === "function"
          ? (await engine.listStatus()).filter((job) => job.anchor.repository === anchor.repository)
          : [];
        const liveIds = new Set(live.map((job) => job.consultationId));
        return {
          content: [{
            type: "text",
            text: `Recent consultations for ${anchor.repository}: ${live.length + recent.filter((c) => !liveIds.has(c.consultationId)).length} records.`,
          }],
          details: {
            ok: true,
            repository: anchor.repository,
            recentConsultations: [
              ...live.map((job) => ({
                consultationId: job.consultationId,
                kind: job.kind,
                status: job.state,
                checkpoint: job.anchor.resolvedCommit,
                createdAt: job.createdAt,
              })),
              ...recent.filter((c) => !liveIds.has(c.consultationId)).map((c) => ({
              consultationId: c.consultationId,
              kind: c.kind,
              status: c.status,
              checkpoint: c.resolvedCommit,
              createdAt: c.createdAt,
              })),
            ],
          },
        };
      },
    };
  }

  private createFollowUpTool(): AdviserToolDefinition {
    return {
      name: "advisor_followup",
      description: "Submit a follow-up consultation anchored to a previous thread (INV-01, INV-09)",
      parameters: {
        type: "object",
        properties: {
          consultationId: { type: "string", description: "Previous consultation ID" },
          request: { type: "string", description: "Follow-up question or request" },
          cwd: { type: "string", description: "Working directory" },
        },
        required: ["consultationId", "request"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const rawParams = params as Record<string, unknown>;
        const priorId = rawParams?.consultationId as ConsultationId;
        const request = (rawParams?.request as string) || "";
        const cwd = (rawParams?.cwd as string | undefined) ?? ctx?.cwd ?? process.cwd();
        const config = await this.resolveConfig(cwd);
        if (!config.enabled) {
          return {
            content: [{ type: "text", text: "Follow-up refused: adviser consultations are disabled by configuration." }],
            details: { ok: false, failure: "disabled" },
          };
        }
        if (!isPiProjectTrusted(ctx)) {
          return {
            content: [{ type: "text", text: "Follow-up refused: Pi does not trust this project." }],
            details: { ok: false, failure: "project-untrusted" },
          };
        }

        const checkpointRes = await resolveCheckpoint({
          git: this.git,
          github: this.github,
          cwd,
          requestedRef: "HEAD",
        });
        if (!checkpointRes.ok) {
          return {
            content: [{ type: "text", text: `Checkpoint error: ${checkpointRes.refusal.explanation}` }],
            details: { ok: false, error: checkpointRes.refusal.explanation },
          };
        }

        const { anchor, workingState } = checkpointRes.resolved;
        const entries = await this.ledger.list({ repository: anchor.repository });
        const prior = entries.find((e) => e.consultationId === priorId);
        if (!prior) {
          return {
            content: [{ type: "text", text: `Prior consultation ${priorId} not found.` }],
            details: { ok: false, error: `Prior consultation ${priorId} not found.` },
          };
        }

        let sessionId: string | undefined;
        try {
          sessionId = getPiSessionId(ctx as AdviserExtensionContext);
        } catch {
          // Read-only/test callers may not have a Pi session. The persisted task remains the
          // conversation scope; live Pi calls include the session digest for delivery routing.
        }

        const followUpId = generateConsultationId();
        const priorActionItems = prior.actionItems.map((item) => ({
          id: item.id,
          summary: item.summary,
          disposition: item.disposition,
          dispositionNote: item.dispositionNote,
        }));

        const brief = buildFollowUpBrief({
          consultationId: followUpId,
          previousConsultationId: prior.consultationId,
          kind: prior.kind,
          repository: anchor.repository,
          branch: workingState.branch ?? null,
          previousCheckpoint: prior.resolvedCommit,
          newCheckpoint: anchor.resolvedCommit,
          prNumber: anchor.pullRequest?.number,
          priorActionItems,
          goal: request,
          question: `What adjustments are recommended based on progress since ${prior.consultationId}?`,
        });

        const engine = await this.resolveEngine(cwd).catch(() => undefined);
        if (engine) {
          try {
            if (config.defaultMode === "async") {
              const dispatched = await engine.submitAsync({
                anchor,
                branch: workingState.branch ?? null,
                taskId: prior.taskId,
                ...(sessionId === undefined ? {} : { sessionId }),
                kind: prior.kind,
                dependency: config.dependencyDefault,
                mode: "async",
                prompt: brief,
                consultationId: followUpId,
                modelPreference: this.modelPreference,
              });
              return {
                content: [{
                  type: "text",
                  text: `Follow-up ${dispatched.consultationId} queued for asynchronous delivery.`,
                }],
                details: {
                  ok: true,
                  consultationId: dispatched.consultationId,
                  state: dispatched.state,
                  mode: "async",
                },
              };
            }

            const turnResult = await engine.submitSync({
              anchor,
              branch: workingState.branch ?? null,
              taskId: prior.taskId,
              ...(sessionId === undefined ? {} : { sessionId }),
              kind: prior.kind,
              dependency: config.dependencyDefault,
              mode: "sync",
              prompt: brief,
              consultationId: followUpId,
              modelPreference: this.modelPreference,
              timeoutMs: config.syncTimeoutMs,
            });

            if (turnResult.ok) {
              return {
                content: [{
                  type: "text",
                  text: `Follow-up ${followUpId} completed for ${priorId}.`,
                }],
                details: {
                  ok: true,
                  consultationId: followUpId,
                  response: turnResult.response.text,
                },
              };
            }

            return {
              content: [{
                type: "text",
                text: `Follow-up ${followUpId} degraded: ${turnResult.failure}`,
              }],
              details: {
                ok: false,
                consultationId: followUpId,
                failure: turnResult.failure,
              },
            };
          } catch (err) {
            return {
              content: [{
                type: "text",
                text: `Follow-up failed: ${err instanceof Error ? err.message : String(err)}`,
              }],
              details: {
                ok: false,
                consultationId: followUpId,
                error: err instanceof Error ? err.message : String(err),
              },
            };
          }
        }

        return {
          content: [{ type: "text", text: `Follow-up ${followUpId} could not start: adviser engine unavailable.` }],
          details: {
            ok: false,
            consultationId: followUpId,
            failure: "engine-unavailable",
            explanation: "The production adviser service is not configured or could not be initialized.",
          },
        };
      },
    };
  }

  private createCancelTool(): AdviserToolDefinition {
    return {
      name: "advisor_cancel",
      description: "Cancel an active consultation (INV-07)",
      parameters: {
        type: "object",
        properties: {
          consultationId: { type: "string", description: "Consultation ID to cancel" },
          cwd: { type: "string", description: "Working directory" },
        },
        required: ["consultationId"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const rawParams = params as Record<string, unknown>;
        const consultationId = rawParams?.consultationId as string;
        if (!isConsultationId(consultationId)) {
          return {
            content: [{ type: "text", text: `Invalid consultation ID format: ${consultationId}` }],
            details: { ok: false, error: `Invalid consultation ID format: ${consultationId}` },
          };
        }

        const cwd = (rawParams?.cwd as string | undefined) ?? ctx?.cwd ?? process.cwd();
        if (!isPiProjectTrusted(ctx)) {
          return {
            content: [{ type: "text", text: "Cancellation refused: Pi does not trust this project." }],
            details: { ok: false, consultationId, failure: "project-untrusted" },
          };
        }
        const checkpointRes = await resolveCheckpoint({
          git: this.git,
          github: this.github,
          cwd,
          requestedRef: "HEAD",
        });
        if (!checkpointRes.ok) {
          return {
            content: [{ type: "text", text: `Consultation ${consultationId} could not be cancelled: ${checkpointRes.refusal.explanation}` }],
            details: { ok: false, consultationId, failure: "checkpoint-refusal" },
          };
        }
        const engine = await this.resolveEngine(cwd).catch(() => undefined);
        if (engine) {
          const { anchor } = checkpointRes.resolved;
          try {
            if (typeof engine.cancelByConsultationId !== "function") {
              return {
                content: [{ type: "text", text: `Consultation ${consultationId} could not be cancelled: engine does not support ID-scoped cancellation.` }],
                details: { ok: false, consultationId, failure: "cancel-unsupported" },
              };
            }
            const sessionId = getPiSessionId(ctx as AdviserExtensionContext);
            const record = await engine.cancelByConsultationId(consultationId, {
              repository: anchor.repository,
              sessionId,
            });
            if (record.state !== "cancelled") {
              return {
                content: [{ type: "text", text: `Consultation ${consultationId} is already ${record.state}.` }],
                details: { ok: true, consultationId, state: record.state },
              };
            }
          } catch (err) {
            return {
              content: [{ type: "text", text: `Consultation ${consultationId} could not be cancelled: ${err instanceof Error ? err.message : String(err)}` }],
              details: { ok: false, consultationId, failure: "cancel-failed" },
            };
          }
        }

        if (!engine) {
          return {
            content: [{ type: "text", text: `Consultation ${consultationId} could not be cancelled: adviser engine unavailable.` }],
            details: { ok: false, consultationId, failure: "engine-unavailable" },
          };
        }

        return {
          content: [{ type: "text", text: `Consultation ${consultationId} cancelled.` }],
          details: { ok: true, cancelled: consultationId },
        };
      },
    };
  }

  private createAuthTool(): AdviserToolDefinition {
    return {
      name: "advisor_auth",
      description: "Inspect ChatGPT adviser authentication status (INV-12, INV-13)",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        const paths = stateStoragePaths();
        const profile = adviserProfileFor(paths);
        let status = await adviserStatus(profile);
        // Pi OAuth is the first auth layer. Avoid creating/launching the adviser browser when it is
        // absent; an API key or missing credential cannot establish ChatGPT web readiness.
        const loginPort = status.openAiSignIn.present
          ? await this.resolveLoginPort(ctx?.cwd ?? process.cwd()).catch(() => undefined)
          : undefined;
        if (status.profile.exists && loginPort) {
          const browserSession = await loginPort.observeSession(profile).catch(() => ({
            kind: "unreachable",
            reason: "browser-failed",
          } as const));
          status = await adviserStatus(profile, { browserSession });
        }
        const authenticated: boolean | "unknown" =
          status.browserSession.state === "signed-in"
            ? true
            : status.browserSession.state === "signed-out" ||
                status.browserSession.state === "human-verification" ||
                status.browserSession.state === "unreachable"
              ? false
              : "unknown";

        return {
          content: [{
            type: "text",
            text: `Adviser authentication: authenticated=${String(authenticated)}`,
          }],
          details: {
            // This is intentionally based on a fresh isolated-browser observation, never Pi OAuth.
            // Unknown is a first-class state when no browser observer was supplied.
            authenticated,
            browserSession: status.browserSession,
            piOpenAiSignInPresent: status.openAiSignIn.present,
            plan: status.openAiSignIn.present ? status.openAiSignIn.planHint : undefined,
            emailMasked: status.openAiSignIn.present ? status.openAiSignIn.emailMasked : undefined,
            accountIdPrefix: status.openAiSignIn.present ? status.openAiSignIn.accountIdPrefix : undefined,
            reason: !status.openAiSignIn.present ? status.openAiSignIn.reason : undefined,
            profileExists: status.profile.exists,
          },
        };
      },
    };
  }

  private createDispositionTool(): AdviserToolDefinition {
    return {
      name: "advisor_disposition",
      description: "Record worker or user disposition on an adviser action item (INV-01, INV-15)",
      parameters: {
        type: "object",
        properties: {
          consultationId: { type: "string", description: "Consultation ID" },
          actionItemId: { type: "string", description: "Action item ID (e.g., A1, A2)" },
          disposition: {
            type: "string",
            enum: [
              "pending",
              "accepted",
              "implemented",
              "partially_implemented",
              "rejected_with_reason",
              "superseded",
              "stale",
              "needs_reconsultation",
            ],
            description: "New disposition for the action item",
          },
          reason: { type: "string", description: "Reason (required for rejected_with_reason or superseded)" },
          cwd: { type: "string", description: "Working directory" },
        },
        required: ["consultationId", "actionItemId", "disposition"],
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const rawParams = params as Record<string, unknown>;
        const consultationId = rawParams?.consultationId as ConsultationId;
        const actionItemId = rawParams?.actionItemId as string;
        const disposition = rawParams?.disposition as ActionItemDisposition;
        const reason = rawParams?.reason as string | undefined;
        const cwd = (rawParams?.cwd as string | undefined) ?? ctx?.cwd ?? process.cwd();

        if (!isPiProjectTrusted(ctx)) {
          return {
            content: [{ type: "text", text: "Disposition refused: Pi does not trust this project." }],
            details: { ok: false, consultationId, failure: "project-untrusted" },
          };
        }

        const checkpointRes = await resolveCheckpoint({
          git: this.git,
          github: this.github,
          cwd,
          requestedRef: "HEAD",
        });
        if (!checkpointRes.ok) {
          return {
            content: [{ type: "text", text: `Checkpoint error: ${checkpointRes.refusal.explanation}` }],
            details: { ok: false, error: checkpointRes.refusal.explanation },
          };
        }

        const { anchor } = checkpointRes.resolved;

        try {
          const updated = await recordActionItemDisposition(this.ledger, {
            consultationId,
            repository: anchor.repository,
            actionItemId,
            disposition,
            reason,
          });

          return {
            content: [{
              type: "text",
              text: `Action item ${actionItemId} updated to ${disposition}.`,
            }],
            details: {
              ok: true,
              consultationId,
              actionItemId,
              disposition,
              updatedActionItems: updated.actionItems,
            },
          };
        } catch (err) {
          return {
            content: [{
              type: "text",
              text: `Disposition error: ${err instanceof Error ? err.message : String(err)}`,
            }],
            details: {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    };
  }
}
