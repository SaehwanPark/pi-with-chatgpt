/**
 * `extension/` — Pi-facing registration and lifecycle.
 *
 * An adviser extension that fails to authenticate, finds no browser, or has a malformed configuration
 * must not degrade a normal Pi session, so activation is pure: no filesystem writes, no browser launch,
 * no network, no git invocation. Commands and tools are wired at activation time.
 */

import type { AdviserExtensionApi } from "./pi-api.js";
import { DEFAULT_CONFIG, type AdviserConfig } from "../config/schema.js";
import { CommandManager, type CommandServiceOptions } from "./commands.js";
import { ToolManager, type ToolServiceOptions } from "./tools.js";

export * from "./pi-api.js";
export * from "./commands.js";
export * from "./tools.js";

export interface AdviserActivation {
  readonly config: AdviserConfig;
  readonly registeredCommands: readonly string[];
  readonly registeredTools: readonly string[];
}

export interface ActivationOptions extends CommandServiceOptions, ToolServiceOptions {
  readonly config?: AdviserConfig;
}

export function activate(pi: AdviserExtensionApi, options?: AdviserConfig | ActivationOptions): AdviserActivation {
  const config = options && "dependencyDefault" in options ? options : options?.config ?? DEFAULT_CONFIG;
  const commandOpts: CommandServiceOptions = options && !("dependencyDefault" in options) ? options : { config };
  const toolOpts: ToolServiceOptions = options && !("dependencyDefault" in options) ? options : { config };

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
