/**
 * `extension/` — Pi-facing registration and lifecycle.
 *
 * An adviser extension that fails to authenticate, finds no browser, or has a malformed configuration
 * must not degrade a normal Pi session, so activation is pure: no filesystem writes, no browser launch,
 * no network, no git invocation. Commands and tools are wired at activation time.
 */

import {
  getPiSessionId,
  isPiProjectTrusted,
  type AdviserExtensionApi,
  type AdviserExtensionContext,
} from "./pi-api.js";
import { DEFAULT_CONFIG, loadAdviserConfig, type AdviserConfig } from "../config/schema.js";
import { CommandManager, type CommandServiceOptions } from "./commands.js";
import { ToolManager, type ToolServiceOptions } from "./tools.js";
import type { ConsultationEngine, WakeUpNotification } from "../jobs/engine.js";
import { formatCompletionNotification } from "../ui/tui.js";
import { createProductionServiceFactory } from "./services.js";

export * from "./pi-api.js";
export * from "./commands.js";
export * from "./tools.js";
export * from "./services.js";

export interface AdviserActivation {
  readonly config: AdviserConfig;
  readonly registeredCommands: readonly string[];
  readonly registeredTools: readonly string[];
}

export interface ActivationOptions extends CommandServiceOptions, ToolServiceOptions {
  readonly config?: AdviserConfig;
}

type EngineResolver = (cwd: string) => Promise<ConsultationEngine | undefined>;

/**
 * Bind async completion delivery to the current Pi session lifecycle.
 *
 * Pi reloads an extension instance when switching, resuming, or forking sessions. Registering the
 * listener on `session_start` and disposing it on `session_shutdown` keeps delivery scoped to the
 * real `sessionManager.getSessionId()` and prevents a stale instance from receiving another session's
 * result. Engine creation remains lazy and failures remain non-fatal to the worker session.
 */
export function registerSessionLifecycle(pi: AdviserExtensionApi, resolveEngine: EngineResolver): void {
  let unsubscribe: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    unsubscribe?.();
    unsubscribe = undefined;

    // Reconciliation can touch durable adviser state and bind wake-up delivery. A missing or
    // failing Pi trust capability is not proof of trust; fail closed before resolving the lazy
    // production service graph so an untrusted workspace cannot initialize adviser automation.
    if (!isPiProjectTrusted(ctx)) {
      ctx.ui.notify("Adviser async delivery is unavailable: Pi does not trust this project.", "warning");
      return;
    }

    const engine = await resolveEngine(ctx.cwd).catch(() => undefined);
    if (!engine) return;

    // Reconcile durable jobs before binding wake-up delivery. This is a store-only operation: resolving
    // the production service creates the browser graph lazily, but reconciliation never starts Chrome.
    if (typeof engine.reconcile === "function") await engine.reconcile().catch(() => undefined);

    let sessionId: string;
    try {
      sessionId = getPiSessionId(ctx);
    } catch (err) {
      // A malformed host context must not take down the Pi session. Without a stable identity,
      // leave async delivery unbound rather than risking cross-session notification.
      ctx.ui.notify(
        `Adviser async delivery is unavailable: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
      return;
    }
    unsubscribe = engine.registerWakeUpListener(sessionId, (notification) => {
      notifyAsyncCompletion(ctx, notification);
    });
  });

  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
  });
}

function notifyAsyncCompletion(ctx: AdviserExtensionContext, notification: WakeUpNotification): void {
  const { address, state, record, response } = notification;
  if (state === "completed" && record && response) {
    const actionItems = (record.result?.actionItems ?? []).map((item, index) => ({
      ordinal: index + 1,
      summary: item.summary,
    }));
    ctx.ui.notify(
      formatCompletionNotification({
        consultationId: address.consultationId,
        kind: record.kind,
        actionItems,
      }),
      "info",
    );
    return;
  }

  const severity = state === "failed" ? "warning" : "info";
  ctx.ui.notify(
    `Consultation ${address.consultationId} ${state}. Run /advisor-status ${address.consultationId} to inspect it.`,
    severity,
  );
}

export function activate(pi: AdviserExtensionApi, options?: AdviserConfig | ActivationOptions): AdviserActivation {
  const directConfig = options && "dependencyDefault" in options ? options : undefined;
  const suppliedOptions: ActivationOptions = options && !("dependencyDefault" in options) ? options : {};
  const hasExplicitConfig = directConfig !== undefined || suppliedOptions.config !== undefined;
  const config = directConfig ?? suppliedOptions.config ?? DEFAULT_CONFIG;
  const configFactory = suppliedOptions.configFactory ?? (hasExplicitConfig ? undefined : (cwd: string) => loadAdviserConfig({ cwd }));
  const productionServices = createProductionServiceFactory({
    config,
    configFactory,
    git: suppliedOptions.git,
    ledger: suppliedOptions.ledger,
  });
  const productionEngine = async (cwd: string) => (await productionServices(cwd)).engine;
  const productionLoginPort = async (cwd: string) => (await productionServices(cwd)).loginPort;
  const commandOpts: CommandServiceOptions = {
    ...suppliedOptions,
    config,
    configFactory,
    engineFactory: suppliedOptions.engineFactory ?? productionEngine,
    loginPortFactory: suppliedOptions.loginPortFactory ?? productionLoginPort,
  };
  const toolOpts: ToolServiceOptions = {
    ...suppliedOptions,
    config,
    configFactory,
    engineFactory: suppliedOptions.engineFactory ?? productionEngine,
    loginPortFactory: suppliedOptions.loginPortFactory ?? productionLoginPort,
  };

  const commandManager = new CommandManager(commandOpts);
  const commands = commandManager.getCommands();
  const registeredCommands: string[] = [];

  for (const [name, definition] of Object.entries(commands)) {
    pi.registerCommand(name, definition);
    registeredCommands.push(name);
  }

  const toolManager = new ToolManager(toolOpts);
  const tools = toolManager.getTools();
  const registeredTools: string[] = [];

  if (typeof pi.registerTool === "function") {
    for (const tool of tools) {
      pi.registerTool(tool);
      registeredTools.push(tool.name);
    }
  }

  const resolveEngine: EngineResolver = async (cwd) => {
    if (commandOpts.engine) return commandOpts.engine;
    if (commandOpts.engineFactory) return await commandOpts.engineFactory(cwd);
    if (toolOpts.engine) return toolOpts.engine;
    if (toolOpts.engineFactory) return await toolOpts.engineFactory(cwd);
    return undefined;
  };
  if (commandOpts.engine || commandOpts.engineFactory || toolOpts.engine || toolOpts.engineFactory) {
    registerSessionLifecycle(pi, resolveEngine);
  }

  return {
    config,
    registeredCommands,
    registeredTools,
  };
}

/** Pi extension entry point. */
export default function activateExtension(pi: AdviserExtensionApi): AdviserActivation {
  return activate(pi);
}
