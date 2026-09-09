/**
 * Configuration that is safe to share and safe to persist (INV-12).
 *
 * Two failure modes are designed out:
 *
 * - **Credentials in config.** Any key that looks like credential material is rejected, not ignored,
 *   so a user who tries to paste a token gets an error explaining that authentication lives in the
 *   isolated browser profile.
 * - **Project-local config with authority.** Project-scope configuration may tune advisory behaviour
 *   only; it cannot point the extension at a different browser profile or state root, because a
 *   cloned repository must not be able to redirect where adviser cookies are written.
 */

import { DEFAULT_DEPENDENCY_MODE, type DependencyMode } from "../protocol/dependency.js";
import { DEFAULT_ADVISER_PROVIDER, type AdviserProvider } from "../protocol/provider.js";
import { isLikelyUserBrowserProfile } from "../browser/profile.js";

export type ConfigScope = "global" | "project";

export interface AdviserConfig {
  readonly provider: AdviserProvider;
  readonly enabled: boolean;
  readonly dependencyDefault: DependencyMode;
  readonly defaultMode: "sync" | "async";
  /** Milliseconds a synchronous consultation waits before it is treated as failed. */
  readonly syncTimeoutMs: number;
  /** Polling cadence for asynchronous jobs; kept coarse to avoid hammering the browser runtime. */
  readonly pollIntervalMs: number;
  readonly autoConsult: {
    readonly enabled: boolean;
    /** Ask before every auto-consultation instead of dispatching silently. */
    readonly confirmBeforeDispatch: boolean;
  };
  /** Explicit opt-in only: never points at the user's browser profile (enforced below). */
  readonly browserExecutablePath?: string;
  readonly logLevel: "silent" | "info" | "verbose";
}

export const DEFAULT_CONFIG: AdviserConfig = {
  provider: DEFAULT_ADVISER_PROVIDER,
  enabled: true,
  dependencyDefault: DEFAULT_DEPENDENCY_MODE,
  defaultMode: "sync",
  syncTimeoutMs: 240_000,
  pollIntervalMs: 5_000,
  autoConsult: { enabled: false, confirmBeforeDispatch: true },
  logLevel: "info",
};

export class ConfigError extends Error {
  constructor(reason: string) {
    super(`Invalid pi-with-chatgpt configuration: ${reason}`);
    this.name = "ConfigError";
  }
}

/** Rejected outright: authentication belongs to the isolated browser profile, never to config. */
const FORBIDDEN_CONFIG_KEYS = /^(cookie|cookies|token|tokens|authorization|apikey|api_key|secret|password|clientsecret|refreshtoken|accesstoken|profilepath|userdatadir|chromeprofile|browserprofile|statemanagerkey)$/iu;

const MAX_SYNC_TIMEOUT_MS = 900_000;
const MAX_POLL_INTERVAL_MS = 600_000;

/**
 * Parse a raw configuration object. `scope` decides how much authority the input has; project-scope
 * input loses every key that could redirect runtime state or the browser binary.
 */
export function parseAdviserConfig(raw: Record<string, unknown>, scope: ConfigScope = "global"): AdviserConfig {
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG };

  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_CONFIG_KEYS.test(key)) {
      throw new ConfigError(
        `"${key}" is not a configuration option. ChatGPT authentication lives in the extension-owned browser profile and is never supplied through configuration.`,
      );
    }
    switch (key) {
      case "provider":
        // V1 is single-provider; anything else is a roadmap decision, not a config value.
        if (value !== DEFAULT_ADVISER_PROVIDER) throw new ConfigError(`provider must be "${DEFAULT_ADVISER_PROVIDER}"`);
        break;
      case "enabled":
        assertBoolean(key, value);
        config.enabled = value;
        break;
      case "autoConsult":
        config.autoConsult = parseAutoConsult(value, scope);
        break;
      case "dependencyDefault":
        if (value !== "advisory" && value !== "required") {
          throw new ConfigError('dependencyDefault must be "advisory" or "required"');
        }
        config.dependencyDefault = value;
        break;
      case "defaultMode":
        if (value !== "sync" && value !== "async") throw new ConfigError('defaultMode must be "sync" or "async"');
        config.defaultMode = value;
        break;
      case "syncTimeoutMs":
        config.syncTimeoutMs = assertRange(key, value, 5_000, MAX_SYNC_TIMEOUT_MS);
        break;
      case "pollIntervalMs":
        config.pollIntervalMs = assertRange(key, value, 1_000, MAX_POLL_INTERVAL_MS);
        break;
      case "logLevel":
        if (value !== "silent" && value !== "info" && value !== "verbose") {
          throw new ConfigError('logLevel must be "silent", "info", or "verbose"');
        }
        config.logLevel = value;
        break;
      case "browserExecutablePath":
        // Project-local configuration cannot choose the binary the extension launches.
        if (scope === "project") throw new ConfigError("browserExecutablePath may only be set globally");
        config.browserExecutablePath = assertBrowserExecutable(value);
        break;
      default:
        // Unknown keys are an error: silently dropping them hides typos behind working defaults.
        throw new ConfigError(`unknown option "${key}"`);
    }
  }

  return config as unknown as AdviserConfig;
}

function parseAutoConsult(value: unknown, scope: ConfigScope): AdviserConfig["autoConsult"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("autoConsult must be an object");
  }
  const enabled = (value as Record<string, unknown>).enabled ?? false;
  assertBoolean("autoConsult.enabled", enabled);
  const confirm = (value as Record<string, unknown>).confirmBeforeDispatch ?? true;
  assertBoolean("autoConsult.confirmBeforeDispatch", confirm);
  if (scope === "project" && enabled === true) {
    throw new ConfigError("a project cannot enable auto-consultation; that is a user-level decision");
  }
  return { enabled: enabled as boolean, confirmBeforeDispatch: confirm as boolean };
}

function assertBrowserExecutable(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ConfigError("browserExecutablePath must be a path");
  if (isLikelyUserBrowserProfile(value)) {
    throw new ConfigError("browserExecutablePath must not point at the user's browser profile");
  }
  return value;
}

function assertBoolean(key: string, value: unknown): void {
  if (typeof value !== "boolean") throw new ConfigError(`${key} must be a boolean`);
}

function assertRange(key: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be a number between ${min} and ${max}`);
  }
  return value;
}
