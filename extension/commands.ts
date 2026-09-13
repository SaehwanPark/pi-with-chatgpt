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

import { getPiSessionId, isPiProjectTrusted, type AdviserCommandContext, type AdviserCommandDefinition } from "./pi-api.js";
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
import { authDecisionAllowsConsultation, resolveLiveAdviserAuth, type AdviserAuthDecision } from "../auth/readiness.js";
import { resolveCheckpoint } from "../git/checkpoint-resolution.js";
import { createGitExecutor, createNodeCommandRunner, type GitExecutor } from "../git/exec.js";
import type { GitHubApi } from "../git/github-api.js";
import { createGitHubApi } from "../git/github-api.js";
import { adviserStateLayout } from "../config/state-layout.js";
import { adviserProfileFor, stateStoragePaths } from "../browser/state-storage.js";
import type { ConsultationEngine } from "../jobs/engine.js";
import { generateConsultationId, scopedTaskIdForSession } from "../jobs/record.js";
import { DEFAULT_MODEL_PREFERENCE } from "../browser/model-selection.js";
import type { ConsultationCapabilityGate } from "../browser/consultation-capability.js";
import { parseAdviserResponse } from "../protocol/response.js";

export interface CommandServiceOptions {
  readonly config?: AdviserConfig;
  /** Lazy loader for global/project configuration; activation remains side-effect free. */
  readonly configFactory?: (cwd: string) => Promise<AdviserConfig>;
  readonly git?: GitExecutor;
  readonly github?: GitHubApi;
  readonly ledger?: ConsultationLedger;
  readonly engine?: ConsultationEngine;
  /** Lazy production composition; test fixtures may inject an engine directly instead. */
  readonly engineFactory?: (cwd: string) => Promise<ConsultationEngine>;
  readonly loginPort?: AdviserLoginPort;
  /** Lazy production login adapter over the extension-owned browser profile. */
  readonly loginPortFactory?: (cwd: string) => Promise<AdviserLoginPort>;
  /** Ranked adviser model preferences; resolved against the live ChatGPT model picker by the engine. */
  readonly modelPreference?: readonly string[];
  /** Authoritative production preflight shared with the engine; absent only for direct test seams. */
  readonly capabilityGate?: ConsultationCapabilityGate;
  readonly capabilityGateFactory?: (cwd: string) => Promise<ConsultationCapabilityGate>;
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

export class CommandManager {
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
  private readonly capabilityGate?: ConsultationCapabilityGate;
  private readonly capabilityGateFactory?: (cwd: string) => Promise<ConsultationCapabilityGate>;

  constructor(options: CommandServiceOptions = {}) {
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
    this.capabilityGate = options.capabilityGate;
    this.capabilityGateFactory = options.capabilityGateFactory;
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
      // A malformed optional settings file must not become an unhandled Pi command rejection. The
      // caller keeps the safe defaults and reports the adviser as unavailable when it needs services.
      return this.config;
    }
  }

  private async resolveCapabilityGate(cwd: string): Promise<ConsultationCapabilityGate | undefined> {
    if (this.capabilityGate) return this.capabilityGate;
    if (this.capabilityGateFactory) return await this.capabilityGateFactory(cwd);
    return undefined;
  }

  private async requireCapability(
    cwd: string,
    anchor: Parameters<ConsultationCapabilityGate["ensureConsultationCapability"]>[0]["anchor"],
    ctx: AdviserCommandContext,
  ): Promise<boolean> {
    let gate: ConsultationCapabilityGate | undefined;
    try {
      gate = await this.resolveCapabilityGate(cwd);
    } catch {
      ctx.ui.notify("Consultation refused: capability verification could not be initialized.", "error");
      return false;
    }
    if (gate === undefined) return true;
    try {
      const result = await gate.ensureConsultationCapability({ anchor, modelPreference: this.modelPreference });
      if (result.ok) return true;
      ctx.ui.notify(`Consultation refused: ${result.explanation}`, "error");
    } catch {
      ctx.ui.notify("Consultation refused: capability verification failed.", "error");
    }
    return false;
  }

  /**
   * Probe the production auth boundary before dispatch. Directly injected engines are test seams and
   * deliberately retain their existing behaviour; the lazy production composition always supplies an
   * engine factory, so live calls cannot bypass the Pi/browser identity resolver.
   */
  private async resolveLiveAuth(cwd: string): Promise<AdviserAuthDecision | undefined> {
    if (!this.engineFactory && !this.loginPortFactory) return undefined;
    const paths = stateStoragePaths();
    const profile = adviserProfileFor(paths);
    const status = await adviserStatus(profile);
    let browserSession: Awaited<ReturnType<AdviserLoginPort["observeSession"]>> | undefined;
    if (status.openAiSignIn.present && status.profile.exists) {
      const loginPort = await this.resolveLoginPort(cwd).catch(() => undefined);
      if (loginPort) browserSession = await loginPort.observeSession(profile).catch(() => undefined);
    }
    return await resolveLiveAdviserAuth({ profile, browserSession, requireBrowserIdentity: true });
  }

  private async requireLiveAuth(cwd: string, ctx: AdviserCommandContext): Promise<boolean> {
    let decision: AdviserAuthDecision | undefined;
    try {
      decision = await this.resolveLiveAuth(cwd);
    } catch {
      ctx.ui.notify("Consultation refused: live adviser authentication could not be verified.", "error");
      return false;
    }
    if (decision === undefined || authDecisionAllowsConsultation(decision)) return true;
    const severity = decision.action === "review-account-mismatch" ? "error" : "warning";
    ctx.ui.notify(`Consultation refused: ${decision.explanation}`, severity);
    return false;
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
    const config = await this.resolveConfig(cwd);
    if (!config.enabled) {
      ctx.ui.notify("Adviser consultations are disabled by configuration.", "warning");
      return;
    }
    if (!isPiProjectTrusted(ctx)) {
      ctx.ui.notify("Consultation refused: Pi does not trust this project.", "error");
      return;
    }

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

    if (!(await this.requireLiveAuth(cwd, ctx))) return;

    const { anchor, workingState } = checkpointRes.resolved;
    if (!(await this.requireCapability(cwd, anchor, ctx))) return;
    const consultationId = generateConsultationId();
    const sessionId = getPiSessionId(ctx);
    const taskId = scopedTaskIdForSession(sessionId, "command");

    ctx.ui.notify(
      formatDispatchStatus({
        consultationId,
        kind,
        remoteRepo: anchor.repository,
        commitSha: anchor.resolvedCommit,
        mode: config.defaultMode,
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

    const engine = await this.resolveEngine(cwd).catch(() => undefined);
    if (engine) {
      try {
        if (config.defaultMode === "async") {
          const dispatched = await engine.submitAsync({
            anchor,
            branch: workingState.branch ?? null,
            taskId,
            sessionId,
            kind,
            dependency: config.dependencyDefault,
            mode: "async",
            prompt: brief,
            consultationId,
            modelPreference: this.modelPreference,
          });
          ctx.ui.notify(
            `Consultation ${dispatched.consultationId} queued for asynchronous delivery. Run /advisor-status ${dispatched.consultationId} to check it.`,
            "info",
          );
          return;
        }

        const turnResult = await engine.submitSync({
          anchor,
          branch: workingState.branch ?? null,
          taskId,
          sessionId,
          kind,
          dependency: config.dependencyDefault,
          mode: "sync",
          prompt: brief,
          consultationId,
          modelPreference: this.modelPreference,
          timeoutMs: config.syncTimeoutMs,
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
      ctx.ui.notify(
        `Consultation ${consultationId} could not start: adviser engine unavailable.`,
        "error",
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
    const config = await this.resolveConfig(cwd);
    if (!config.enabled) {
      ctx.ui.notify("Adviser consultations are disabled by configuration.", "warning");
      return;
    }
    if (!isPiProjectTrusted(ctx)) {
      ctx.ui.notify("Follow-up refused: Pi does not trust this project.", "error");
      return;
    }
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

    if (!(await this.requireLiveAuth(cwd, ctx))) return;

    const { anchor, workingState } = checkpointRes.resolved;
    if (!(await this.requireCapability(cwd, anchor, ctx))) return;
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
        mode: config.defaultMode,
        prNumber: anchor.pullRequest?.number,
      }),
      "info",
    );

    const engine = await this.resolveEngine(cwd).catch(() => undefined);
    if (engine) {
      try {
        if (config.defaultMode === "async") {
          const dispatched = await engine.submitAsync({
            anchor,
            branch: workingState.branch ?? null,
            taskId: prior.taskId,
            sessionId: getPiSessionId(ctx),
            kind: prior.kind,
            dependency: config.dependencyDefault,
            mode: "async",
            prompt: brief,
            consultationId: followUpId,
            modelPreference: this.modelPreference,
          });
          ctx.ui.notify(
            `Follow-up ${dispatched.consultationId} queued for asynchronous delivery. Run /advisor-status ${dispatched.consultationId} to check it.`,
            "info",
          );
          return;
        }

        const turnResult = await engine.submitSync({
          anchor,
          branch: workingState.branch ?? null,
          taskId: prior.taskId,
          sessionId: getPiSessionId(ctx),
          kind: prior.kind,
          dependency: config.dependencyDefault,
          mode: "sync",
          prompt: brief,
          consultationId: followUpId,
          modelPreference: this.modelPreference,
          timeoutMs: config.syncTimeoutMs,
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
      ctx.ui.notify(
        `Follow-up ${followUpId} could not start: adviser engine unavailable.`,
        "error",
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
      // JobStore is the live authority. Consult it before the terminal ledger so queued/running
      // work remains visible even when Pi was interrupted before a ledger event was written.
      const engine = await this.resolveEngine(cwd).catch(() => undefined);
      const live = engine && typeof engine.getStatusByConsultationId === "function"
        ? await engine.getStatusByConsultationId(consultationId as ConsultationId, {
            repository: anchor.repository,
            sessionId: getPiSessionId(ctx),
          }).catch(() => undefined)
        : undefined;
      if (live && live.state !== "completed" && live.state !== "failed" && live.state !== "cancelled") {
        ctx.ui.notify(
          `[advisor] ${live.consultationId}: kind=${live.kind} status=${live.state} checkpoint=${live.anchor.resolvedCommit.slice(0, 7)}`,
          "info",
        );
        return;
      }
      const entries = await this.ledger.list({ repository: anchor.repository });
      const record = entries.find((e) => e.consultationId === consultationId);
      if (!record) {
        if (live) {
          ctx.ui.notify(
            `[advisor] ${live.consultationId}: kind=${live.kind} status=${live.state} checkpoint=${live.anchor.resolvedCommit.slice(0, 7)}`,
            "info",
          );
          return;
        }
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
      const engine = await this.resolveEngine(cwd).catch(() => undefined);
      const live = engine && typeof engine.listStatus === "function" ? await engine.listStatus().catch(() => []) : [];
      const visibleLive = live.filter((job) => job.anchor.repository === anchor.repository);
      if (recent.length === 0 && visibleLive.length === 0) {
        ctx.ui.notify(`No consultations recorded for repository ${anchor.repository}.`, "info");
        return;
      }

      const summaryLines = visibleLive.map(
        (job) => `  - ${job.consultationId} [${job.kind}]: ${job.state} (@${job.anchor.resolvedCommit.slice(0, 7)})`,
      );
      const liveIds = new Set(visibleLive.map((job) => job.consultationId));
      summaryLines.push(...recent.filter((entry) => !liveIds.has(entry.consultationId)).map(
        (c) => `  - ${c.consultationId} [${c.kind}]: ${c.status} (@${c.resolvedCommit.slice(0, 7)})`,
      ));
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
    const config = await this.resolveConfig(cwd);
    if (!config.enabled) {
      ctx.ui.notify("Cancellation refused: adviser consultations are disabled by configuration.", "warning");
      return;
    }
    if (!isPiProjectTrusted(ctx)) {
      ctx.ui.notify("Cancellation refused: Pi does not trust this project.", "error");
      return;
    }
    const checkpointRes = await resolveCheckpoint({
      git: this.git,
      github: this.github,
      cwd,
      requestedRef: "HEAD",
    });
    if (!checkpointRes.ok) {
      ctx.ui.notify(
        `Consultation ${consultationId} could not be cancelled: ${checkpointRes.refusal.explanation}`,
        "error",
      );
      return;
    }

    const { anchor } = checkpointRes.resolved;
    const engine = await this.resolveEngine(cwd).catch(() => undefined);
    if (!engine) {
      ctx.ui.notify(
        `Consultation ${consultationId} could not be cancelled: adviser engine unavailable.`,
        "error",
      );
      return;
    }

    try {
      const sessionId = getPiSessionId(ctx);
      if (typeof engine.cancelByConsultationId !== "function") {
        ctx.ui.notify(`Consultation ${consultationId} could not be cancelled: engine does not support ID-scoped cancellation.`, "error");
        return;
      }
      const record = await engine.cancelByConsultationId(consultationId, {
        repository: anchor.repository,
        sessionId,
      });
      if (record.state !== "cancelled") {
        ctx.ui.notify(`Consultation ${consultationId} is already ${record.state}.`, "info");
        return;
      }
    } catch (err) {
      ctx.ui.notify(
        `Consultation ${consultationId} could not be cancelled: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }

    ctx.ui.notify(`Consultation ${consultationId} cancelled.`, "info");
  }

  private async handleAuth(ctx: AdviserCommandContext): Promise<void> {
    const paths = stateStoragePaths();
    const profile = adviserProfileFor(paths);
    let status = await adviserStatus(profile);
    // Preserve the auth precedence: do not initialize the adviser browser until Pi's OpenAI OAuth
    // credential exists. `resolveLoginPort` can prepare state and launch-dependent services.
    const loginPort = status.openAiSignIn.present
      ? await this.resolveLoginPort(ctx.cwd ?? process.cwd()).catch(() => undefined)
      : undefined;

    // Pi's OAuth credential identifies the account that should advise; it is not a live ChatGPT web
    // session. When the production login port is available, perform the browser-side observation and
    // feed that fact into the redacted status snapshot. Without it, keep the state explicitly unknown
    // rather than claiming that the isolated profile is authenticated from the Pi credential alone.
    let browserSession: Awaited<ReturnType<AdviserLoginPort["observeSession"]>> | undefined;
    if (status.profile.exists && loginPort) {
      browserSession = await loginPort.observeSession(profile).catch(() => ({
        kind: "unreachable",
        reason: "browser-failed",
      } as const));
      status = await adviserStatus(profile, { browserSession });
    }

    // This is the only production account comparison. In particular, do not treat the presence of Pi
    // OAuth as proof that the isolated browser belongs to that account. A demonstrated mismatch stops
    // here until a pair-bound human decision is supplied.
    const authDecision = await resolveLiveAdviserAuth({ profile, browserSession, requireBrowserIdentity: true });
    if (authDecision.action === "review-account-mismatch") {
      ctx.ui.notify(`ChatGPT adviser authentication refused: ${authDecision.explanation}`, "error");
      return;
    }

    if (!status.openAiSignIn.present) {
      ctx.ui.notify(
        `ChatGPT adviser sign-in required (${status.openAiSignIn.reason}). The isolated adviser profile is not ready.`,
        "warning",
      );
      if (loginPort) {
        ctx.ui.notify("Run Pi OpenAI login before signing in to the adviser browser.", "info");
      } else {
        ctx.ui.notify("Run Pi OpenAI login to authenticate adviser.", "info");
      }
      return;
    }

    if (status.browserSession.state === "signed-in") {
      const plan = status.openAiSignIn.planHint ? ` (${status.openAiSignIn.planHint})` : "";
      const email = status.openAiSignIn.emailMasked ? ` [${status.openAiSignIn.emailMasked}]` : "";
      ctx.ui.notify(
        `Pi OpenAI sign-in and the isolated ChatGPT browser session are authenticated${plan}${email}. Run adviser preflight to verify model, GitHub connector, and checkpoint access.`,
        "info",
      );
      return;
    }

    if (status.browserSession.state === "human-verification") {
      ctx.ui.notify(
        `ChatGPT adviser needs human verification (${status.browserSession.challenge}) in the isolated browser window.`,
        "warning",
      );
      return;
    }

    if (status.browserSession.state === "unreachable") {
      ctx.ui.notify(
        `ChatGPT adviser browser session could not be checked (${status.browserSession.reason}). Pi OpenAI sign-in is present, but readiness is unverified.`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(
      "Pi OpenAI sign-in is present, but the isolated ChatGPT browser session is not signed in.",
      "warning",
    );

    if (loginPort) {
      ctx.ui.notify("Launching manual login flow in isolated browser window...", "info");
      const outcome = await runManualLogin(profile, loginPort, { timeoutMs: 30_000 });
      if (outcome.ok) {
        ctx.ui.notify("ChatGPT login successful. Adviser is ready.", "info");
      } else {
        ctx.ui.notify(`ChatGPT login did not complete: ${outcome.failure} - ${outcome.detail}`, "error");
      }
    } else {
      ctx.ui.notify("The adviser browser runtime is not available to verify or repair this session.", "info");
    }
  }
}
