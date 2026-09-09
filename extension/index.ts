/**
 * `extension/` — Pi-facing registration and lifecycle.
 *
 * M0 intentionally registers nothing. An adviser extension that fails to authenticate, finds no
 * browser, or has a malformed configuration must not degrade a normal Pi session, so activation is
 * pure: no filesystem writes, no browser launch, no network, no git invocation. Commands arrive in
 * M8 and tools in M5, both through lazy wiring from this entry point.
 */

import type { AdviserExtensionApi } from "./pi-api.js";
import { DEFAULT_CONFIG, type AdviserConfig } from "../config/schema.js";

export * from "./pi-api.js";

export interface AdviserActivation {
  readonly config: AdviserConfig;
  /** Registration performed at activation; empty by contract in M0. */
  readonly registeredCommands: readonly string[];
}

export function activate(_pi: AdviserExtensionApi, config: AdviserConfig = DEFAULT_CONFIG): AdviserActivation {
  return { config, registeredCommands: [] };
}

/** Pi extension entry point. */
export default function activateExtension(pi: AdviserExtensionApi): AdviserActivation {
  return activate(pi);
}
