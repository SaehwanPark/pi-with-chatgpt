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

import { randomUUID } from "node:crypto";
import type { AdviserToolDefinition } from "./pi-api.js";
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
import { resolveCheckpoint } from "../git/checkpoint-resolution.js";
import { createGitExecutor, createNodeCommandRunner, type GitExecutor } from "../git/exec.js";
import type { GitHubApi } from "../git/github-api.js";
import { createGitHubApi } from "../git/github-api.js";
import { adviserStateLayout } from "../config/state-layout.js";
import { adviserProfileFor, stateStoragePaths } from "../browser/state-storage.js";
import type { ConsultationEngine } from "../jobs/engine.js";

export interface ToolServiceOptions {
  readonly config?: AdviserConfig;
  readonly git?: GitExecutor;
  readonly github?: GitHubApi;
  readonly ledger?: ConsultationLedger;
  readonly engine?: ConsultationEngine;
}

function generateConsultationId(): ConsultationId {
  const hex = randomUUID().replace(/[^0-9a-z]/gu, "").slice(0, 10);
  return `adv-${hex}` as ConsultationId;
}

function defaultGitHubApi(): GitHubApi {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  if (token) {
    try {
      return createGitHubApi({
        fetchImpl: globalThis.fetch as unknown as Parameters<typeof createGitHubApi>[0]["fetchImpl"],
        token,
      });
    } catch {
      // ignore
    }
  }
  return {
    checkCommitPresence() {
      return Promise.resolve({ ok: true, value: "present" as const });
    },
    listOpenPullRequestsForHead() {
      return Promise.resolve({ ok: true, value: [] });
    },
  };
}

export class ToolManager {
  private readonly config: AdviserConfig;
  private readonly git: GitExecutor;
  private readonly github: GitHubApi;
  private readonly ledger: ConsultationLedger;
  private readonly engine?: ConsultationEngine;

  constructor(options: ToolServiceOptions = {}) {
    this.config = options.config ?? DEFAULT_CONFIG;
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
        const cwd = (params as Record<string, unknown>)?.cwd as string | undefined ?? (ctx as Record<string, unknown>)?.cwd as string | undefined ?? process.cwd();
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
        const cwd = (rawParams?.cwd as string | undefined) ?? (ctx as Record<string, unknown>)?.cwd as string | undefined ?? process.cwd();
        const taskId = (rawParams?.taskId as string | undefined) ?? (ctx as Record<string, unknown>)?.sessionId as string | undefined ?? "session-default";

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

        if (this.engine) {
          try {
            const turnResult = await this.engine.submitSync({
              anchor,
              branch: workingState.branch ?? "main",
              taskId,
              kind,
              dependency: this.config.dependencyDefault,
              prompt: brief,
              modelId: "chatgpt-default",
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
                  dependency: this.config.dependencyDefault,
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

        // Offline stub
        await this.ledger.recordConsultation(
          {
            schemaVersion: 1,
            consultationId,
            taskId,
            repository: anchor.repository,
            branch: workingState.branch ?? null,
            requestedRef: anchor.requestedRef,
            resolvedCommit: anchor.resolvedCommit,
            headAtDispatch: anchor.resolvedCommit,
            kind,
            dependency: this.config.dependencyDefault,
            projectId: "project-default",
            conversationId: "conv-default",
            status: "completed",
            createdAt: new Date().toISOString(),
            actionItems: [
              { id: "A1", summary: `Address guidance for ${goal}`, disposition: "pending" },
            ],
          },
          `Advisory response for ${kind}: ${goal}\n\n[A1] Address guidance for ${goal}`,
        );

        const stubRecords = await this.ledger.list({ repository: anchor.repository });
        const stubRecord = stubRecords[0];
        if (!stubRecord) {
          return {
            content: [{
              type: "text",
              text: `Consultation ${consultationId} (${kind}) submitted at ${anchor.resolvedCommit.slice(0, 7)}.`,
            }],
            details: {
              ok: true,
              consultationId,
            },
          };
        }

        const advisory = toWorkerFacingAdvisory(stubRecord);
        return {
          content: [{
            type: "text",
            text: `Consultation ${consultationId} (${kind}) submitted and recorded at ${anchor.resolvedCommit.slice(0, 7)}.`,
          }],
          details: {
            ok: true,
            consultationId,
            advisory: {
              ...advisory,
              advice: `Advisory response for ${kind}: ${goal}\n\n[A1] Address guidance for ${goal}`,
            },
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
        const cwd = (rawParams?.cwd as string | undefined) ?? (ctx as Record<string, unknown>)?.cwd as string | undefined ?? process.cwd();

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
        const cwd = (rawParams?.cwd as string | undefined) ?? (ctx as Record<string, unknown>)?.cwd as string | undefined ?? process.cwd();

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
          const entries = await this.ledger.list({ repository: anchor.repository });
          const record = entries.find((e) => e.consultationId === consultationId);
          if (!record) {
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
        return {
          content: [{
            type: "text",
            text: `Recent consultations for ${anchor.repository}: ${recent.length} records.`,
          }],
          details: {
            ok: true,
            repository: anchor.repository,
            recentConsultations: recent.map((c) => ({
              consultationId: c.consultationId,
              kind: c.kind,
              status: c.status,
              checkpoint: c.resolvedCommit,
              createdAt: c.createdAt,
            })),
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
        const cwd = (rawParams?.cwd as string | undefined) ?? (ctx as Record<string, unknown>)?.cwd as string | undefined ?? process.cwd();

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

        if (this.engine) {
          try {
            const turnResult = await this.engine.submitSync({
              anchor,
              branch: workingState.branch ?? "main",
              taskId: prior.taskId,
              kind: prior.kind,
              dependency: this.config.dependencyDefault,
              prompt: brief,
              modelId: "chatgpt-default",
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

        await this.ledger.recordConsultation(
          {
            schemaVersion: 1,
            consultationId: followUpId,
            taskId: prior.taskId,
            repository: anchor.repository,
            branch: workingState.branch ?? null,
            requestedRef: anchor.requestedRef,
            resolvedCommit: anchor.resolvedCommit,
            headAtDispatch: anchor.resolvedCommit,
            kind: prior.kind,
            dependency: this.config.dependencyDefault,
            projectId: prior.projectId,
            conversationId: prior.conversationId,
            status: "completed",
            createdAt: new Date().toISOString(),
            actionItems: [{ id: "A1", summary: `Apply follow-up: ${request}`, disposition: "pending" }],
          },
          `Follow-up advice: ${request}`,
        );

        return {
          content: [{
            type: "text",
            text: `Follow-up ${followUpId} submitted and recorded for ${priorId}.`,
          }],
          details: {
            ok: true,
            consultationId: followUpId,
            advice: `Follow-up advice: ${request}`,
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

        const cwd = (rawParams?.cwd as string | undefined) ?? (ctx as Record<string, unknown>)?.cwd as string | undefined ?? process.cwd();
        const checkpointRes = await resolveCheckpoint({
          git: this.git,
          github: this.github,
          cwd,
          requestedRef: "HEAD",
        });
        if (checkpointRes.ok && this.engine) {
          const { anchor } = checkpointRes.resolved;
          const address = {
            repository: anchor.repository,
            taskId: "session-default",
            consultationId,
            deliveryKey: "0".repeat(64),
          };
          await this.engine.cancel(address);
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
      execute: async () => {
        const paths = stateStoragePaths();
        const profile = adviserProfileFor(paths);
        const status = await adviserStatus(profile);

        return {
          content: [{
            type: "text",
            text: `Adviser authentication: authenticated=${status.openAiSignIn.present}`,
          }],
          details: {
            authenticated: status.openAiSignIn.present,
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
        const cwd = (rawParams?.cwd as string | undefined) ?? (ctx as Record<string, unknown>)?.cwd as string | undefined ?? process.cwd();

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
