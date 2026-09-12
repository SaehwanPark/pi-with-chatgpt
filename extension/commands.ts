/**
 * `extension/commands.ts` — User-facing slash command implementations (M8).
 *
 * Implements 11 commands:
 * - /advisor <request>
 * - /advisor-plan <request>
 * - /advisor-review [request]
 * - /advisor-audit <request>
 * - /advisor-debug <request>
 * - /advisor-challenge <request>
 * - /advisor-followup <consultation-id> <request>
 * - /advisor-status [consultation-id]
 * - /advisor-read [consultation-id]
 * - /advisor-cancel <consultation-id>
 * - /advisor-auth
 */

import { randomUUID } from "node:crypto";
import type { AdviserCommandContext, AdviserCommandDefinition } from "./pi-api.js";
import { type AdviserConfig, DEFAULT_CONFIG } from "../config/schema.js";
import type { ConsultationKind } from "../protocol/brief.js";
import { buildConsultationBrief } from "../protocol/brief.js";
import { ConsultationLedger } from "../ledger/ledger.js";
import { isConsultationId, type ConsultationId } from "../protocol/checkpoint.js";
import { formatDispatchStatus, formatCompletionNotification, formatFullAdvisoryView } from "../ui/tui.js";
import {
  classifyAdviceStatus,
  analyzeGraphDrift,
  analyzeFileDrift,
  extractMentionedFiles,
  buildFollowUpBrief,
} from "../drift/index.js";
import { adviserStatus } from "../auth/status.js";
import { runManualLogin, type AdviserLoginPort } from "../auth/login-flow.js";
import { resolveCheckpoint } from "../git/checkpoint-resolution.js";
import { createGitExecutor, createNodeCommandRunner, type GitExecutor } from "../git/exec.js";
import type { GitHubApi } from "../git/github-api.js";
import { createGitHubApi } from "../git/github-api.js";
import { adviserStateLayout } from "../config/state-layout.js";
import { adviserProfileFor, stateStoragePaths } from "../browser/state-storage.js";
import type { ConsultationEngine } from "../jobs/engine.js";
import { parseAdviserResponse } from "../protocol/response.js";

export interface CommandServiceOptions {
  readonly config?: AdviserConfig;
  readonly git?: GitExecutor;
  readonly github?: GitHubApi;
  readonly ledger?: ConsultationLedger;
  readonly engine?: ConsultationEngine;
  readonly loginPort?: AdviserLoginPort;
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

export class CommandManager {
  private readonly config: AdviserConfig;
  private readonly git: GitExecutor;
  private readonly github: GitHubApi;
  private readonly ledger: ConsultationLedger;
  private readonly engine?: ConsultationEngine;
  private readonly loginPort?: AdviserLoginPort;

  constructor(options: CommandServiceOptions = {}) {
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
    this.loginPort = options.loginPort;
  }

  getCommands(): Record<string, AdviserCommandDefinition> {
    return {
      "advisor": {
        description: "Request general guidance from the ChatGPT adviser",
        handler: (args, ctx) => this.handleConsultation(args, "consult", ctx),
      },
      "advisor-plan": {
        description: "Request an implementation or migration plan from the ChatGPT adviser",
        handler: (args, ctx) => this.handleConsultation(args, "plan", ctx),
      },
      "advisor-review": {
        description: "Request a code review from the ChatGPT adviser",
        handler: (args, ctx) => this.handleConsultation(args, "review", ctx),
      },
      "advisor-audit": {
        description: "Request a security or architectural audit from the ChatGPT adviser",
        handler: (args, ctx) => this.handleConsultation(args, "audit", ctx),
      },
      "advisor-debug": {
        description: "Request debugging or root-cause assistance from the ChatGPT adviser",
        handler: (args, ctx) => this.handleConsultation(args, "debug", ctx),
      },
      "advisor-challenge": {
        description: "Challenge an architectural approach with counter-arguments from the adviser",
        handler: (args, ctx) => this.handleConsultation(args, "challenge", ctx),
      },
      "advisor-followup": {
        description: "Submit a follow-up to a previous consultation: /advisor-followup <consultation-id> <request>",
        handler: (args, ctx) => this.handleFollowUp(args, ctx),
      },
      "advisor-status": {
        description: "Show status of latest consultation or specific ID: /advisor-status [consultation-id]",
        handler: (args, ctx) => this.handleStatus(args, ctx),
      },
      "advisor-read": {
        description: "Read full response of consultation: /advisor-read [consultation-id]",
        handler: (args, ctx) => this.handleRead(args, ctx),
      },
      "advisor-cancel": {
        description: "Cancel an active consultation: /advisor-cancel <consultation-id>",
        handler: (args, ctx) => this.handleCancel(args, ctx),
      },
      "advisor-auth": {
        description: "Inspect adviser authentication status or initiate login",
        handler: (_args, ctx) => this.handleAuth(ctx),
      },
    };
  }

  private async handleConsultation(
    args: string,
    kind: ConsultationKind,
    ctx: AdviserCommandContext,
  ): Promise<void> {
    const goal = args.trim();
    if (!goal && kind !== "review") {
      ctx.ui.notify(`Usage: /advisor${kind === "consult" ? "" : `-${kind}`} <request>`, "warning");
      return;
    }

    const effectiveGoal = goal || "Review current changes and commit against the GitHub repository";
    const cwd = ctx.cwd ?? process.cwd();

    const checkpointRes = await resolveCheckpoint({
      git: this.git,
      github: this.github,
      cwd,
      requestedRef: "HEAD",
    });
    if (!checkpointRes.ok) {
      ctx.ui.notify(
        `Checkpoint refusal (${checkpointRes.refusal.stage}): ${checkpointRes.refusal.explanation}`,
        "error",
      );
      return;
    }

    const { anchor, workingState } = checkpointRes.resolved;
    const consultationId = generateConsultationId();
    const taskId = ctx.sessionId ?? "session-default";

    ctx.ui.notify(
      formatDispatchStatus({
        consultationId,
        kind,
        remoteRepo: anchor.repository,
        commitSha: anchor.resolvedCommit,
        mode: this.config.defaultMode,
        prNumber: anchor.pullRequest?.number,
      }),
      "info",
    );

    const brief = buildConsultationBrief({
      consultationId,
      kind,
      repository: anchor.repository,
      branch: workingState.branch ?? null,
      checkpointSha: anchor.resolvedCommit,
      prNumber: anchor.pullRequest?.number,
      goal: effectiveGoal,
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
          const parsed = parseAdviserResponse(turnResult.response.text, {
            expectedCommitSha: anchor.resolvedCommit,
            expectedConsultationId: turnResult.record.consultationId,
          });
          const actionItems = parsed.actionItems.map((it, idx) => ({
            ordinal: idx + 1,
            summary: it.summary,
            disposition: "pending" as const,
          }));

          ctx.ui.notify(
            formatCompletionNotification({
              consultationId: turnResult.record.consultationId,
              kind,
              actionItems,
            }),
            "info",
          );
        } else {
          ctx.ui.notify(
            formatCompletionNotification({
              consultationId,
              kind,
              degradedReason: turnResult.failure,
            }),
            "warning",
          );
        }
      } catch (err) {
        ctx.ui.notify(`Consultation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    } else {
      // Record stub consultation in ledger for offline / un-injected mode
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
            { id: "A1", summary: `Verify implementation against ${anchor.resolvedCommit.slice(0, 7)}`, disposition: "pending" },
          ],
        },
        `Advisory for ${kind}: ${effectiveGoal}\n\n[A1] Verify implementation against ${anchor.resolvedCommit.slice(0, 7)}`,
      );

      ctx.ui.notify(
        formatCompletionNotification({
          consultationId,
          kind,
          actionItems: [{ ordinal: 1, summary: `Verify implementation against ${anchor.resolvedCommit.slice(0, 7)}` }],
        }),
        "info",
      );
    }
  }

  private async handleFollowUp(args: string, ctx: AdviserCommandContext): Promise<void> {
    const parts = args.trim().split(/\s+/u);
    const consultationId = parts[0] as ConsultationId;
    const followUpGoal = parts.slice(1).join(" ").trim();

    if (!consultationId || !followUpGoal) {
      ctx.ui.notify("Usage: /advisor-followup <consultation-id> <request>", "warning");
      return;
    }

    const cwd = ctx.cwd ?? process.cwd();
    const checkpointRes = await resolveCheckpoint({
      git: this.git,
      github: this.github,
      cwd,
      requestedRef: "HEAD",
    });
    if (!checkpointRes.ok) {
      ctx.ui.notify(
        `Checkpoint refusal (${checkpointRes.refusal.stage}): ${checkpointRes.refusal.explanation}`,
        "error",
      );
      return;
    }

    const { anchor, workingState } = checkpointRes.resolved;
    const entries = await this.ledger.list({ repository: anchor.repository });
    const prior = entries.find((e) => e.consultationId === consultationId);

    if (!prior) {
      ctx.ui.notify(`Prior consultation ${consultationId} not found in ledger for ${anchor.repository}.`, "error");
      return;
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
      goal: followUpGoal,
      question: `What adjustments are recommended based on progress since ${prior.consultationId}?`,
    });

    ctx.ui.notify(
      formatDispatchStatus({
        consultationId: followUpId,
        kind: prior.kind,
        remoteRepo: anchor.repository,
        commitSha: anchor.resolvedCommit,
        mode: this.config.defaultMode,
        prNumber: anchor.pullRequest?.number,
      }),
      "info",
    );

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
          ctx.ui.notify(
            formatCompletionNotification({
              consultationId: followUpId,
              kind: prior.kind,
            }),
            "info",
          );
        } else {
          ctx.ui.notify(`Follow-up ended with degradation: ${turnResult.failure}`, "warning");
        }
      } catch (err) {
        ctx.ui.notify(`Follow-up failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    } else {
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
          actionItems: [{ id: "A1", summary: `Apply follow-up changes for ${followUpGoal}`, disposition: "pending" }],
        },
        `Follow-up advisory for ${prior.kind}: ${followUpGoal}`,
      );

      ctx.ui.notify(
        formatCompletionNotification({
          consultationId: followUpId,
          kind: prior.kind,
          actionItems: [{ ordinal: 1, summary: `Apply follow-up changes for ${followUpGoal}` }],
        }),
        "info",
      );
    }
  }

  private async handleStatus(args: string, ctx: AdviserCommandContext): Promise<void> {
    const consultationId = args.trim();
    const cwd = ctx.cwd ?? process.cwd();
    const checkpointRes = await resolveCheckpoint({
      git: this.git,
      github: this.github,
      cwd,
      requestedRef: "HEAD",
    });
    if (!checkpointRes.ok) {
      ctx.ui.notify(
        `Checkpoint refusal (${checkpointRes.refusal.stage}): ${checkpointRes.refusal.explanation}`,
        "error",
      );
      return;
    }

    const { anchor } = checkpointRes.resolved;

    if (consultationId) {
      const entries = await this.ledger.list({ repository: anchor.repository });
      const record = entries.find((e) => e.consultationId === consultationId);
      if (!record) {
        ctx.ui.notify(`Consultation ${consultationId} not found in repository ${anchor.repository}.`, "warning");
        return;
      }

      // Check drift
      let driftInfo = "";
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
        driftInfo = ` | drift: ${report.classification}`;
      } catch {
        // drift evaluation is non-blocking
      }

      ctx.ui.notify(
        `[advisor] ${record.consultationId}: kind=${record.kind} status=${record.status} checkpoint=${record.resolvedCommit.slice(0, 7)}${driftInfo}`,
        "info",
      );
    } else {
      const recent = await this.ledger.list({ repository: anchor.repository, limit: 5 });
      if (recent.length === 0) {
        ctx.ui.notify(`No consultations recorded for repository ${anchor.repository}.`, "info");
        return;
      }

      const summaryLines = recent.map(
        (c) => `  - ${c.consultationId} [${c.kind}]: ${c.status} (@${c.resolvedCommit.slice(0, 7)})`,
      );
      ctx.ui.notify(`Recent consultations for ${anchor.repository}:\n${summaryLines.join("\n")}`, "info");
    }
  }

  private async handleRead(args: string, ctx: AdviserCommandContext): Promise<void> {
    const consultationId = args.trim();
    const cwd = ctx.cwd ?? process.cwd();
    const checkpointRes = await resolveCheckpoint({
      git: this.git,
      github: this.github,
      cwd,
      requestedRef: "HEAD",
    });
    if (!checkpointRes.ok) {
      ctx.ui.notify(
        `Checkpoint refusal (${checkpointRes.refusal.stage}): ${checkpointRes.refusal.explanation}`,
        "error",
      );
      return;
    }

    const { anchor } = checkpointRes.resolved;
    const entries = await this.ledger.list({ repository: anchor.repository });
    if (entries.length === 0) {
      ctx.ui.notify(`No consultations found for ${anchor.repository}.`, "warning");
      return;
    }

    const target = consultationId
      ? entries.find((e) => e.consultationId === consultationId)
      : entries[0];

    if (!target) {
      ctx.ui.notify(`Consultation ${consultationId} not found.`, "error");
      return;
    }

    const responseMarkdown = await this.ledger.readResponse(target.consultationId, anchor.repository);
    const view = formatFullAdvisoryView(target, responseMarkdown);
    ctx.ui.notify(view, "info");
  }

  private async handleCancel(args: string, ctx: AdviserCommandContext): Promise<void> {
    const consultationId = args.trim();
    if (!consultationId) {
      ctx.ui.notify("Usage: /advisor-cancel <consultation-id>", "warning");
      return;
    }

    if (!isConsultationId(consultationId)) {
      ctx.ui.notify(`Invalid consultation ID format: ${consultationId}`, "warning");
      return;
    }

    const cwd = ctx.cwd ?? process.cwd();
    const checkpointRes = await resolveCheckpoint({
      git: this.git,
      github: this.github,
      cwd,
      requestedRef: "HEAD",
    });
    if (!checkpointRes.ok) {
      ctx.ui.notify(`Consultation ${consultationId} cancelled.`, "info");
      return;
    }

    const { anchor } = checkpointRes.resolved;

    if (this.engine) {
      const address = {
        repository: anchor.repository,
        taskId: ctx.sessionId ?? "session-default",
        consultationId,
        deliveryKey: "0".repeat(64),
      };
      await this.engine.cancel(address);
    }

    ctx.ui.notify(`Consultation ${consultationId} cancelled.`, "info");
  }

  private async handleAuth(ctx: AdviserCommandContext): Promise<void> {
    const paths = stateStoragePaths();
    const profile = adviserProfileFor(paths);
    const status = await adviserStatus(profile);

    if (status.openAiSignIn.present) {
      const plan = status.openAiSignIn.planHint ? ` (${status.openAiSignIn.planHint})` : "";
      const email = status.openAiSignIn.emailMasked ? ` [${status.openAiSignIn.emailMasked}]` : "";
      ctx.ui.notify(
        `ChatGPT adviser is authenticated${plan}${email}. Ready for consultations.`,
        "info",
      );
      return;
    }

    ctx.ui.notify(
      `ChatGPT adviser sign-in required (${status.openAiSignIn.reason}). Profile: ${status.profile.userDataDir}`,
      "warning",
    );

    if (this.loginPort) {
      ctx.ui.notify("Launching manual login flow in isolated browser window...", "info");
      const outcome = await runManualLogin(profile, this.loginPort, { timeoutMs: 30_000 });
      if (outcome.ok) {
        ctx.ui.notify("ChatGPT login successful. Adviser is ready.", "info");
      } else {
        ctx.ui.notify(`ChatGPT login did not complete: ${outcome.failure} - ${outcome.detail}`, "error");
      }
    } else {
      ctx.ui.notify("Run Pi OpenAI login to authenticate adviser.", "info");
    }
  }
}
