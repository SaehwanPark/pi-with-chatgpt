import { homedir } from "node:os";
import { join } from "node:path";

import { SecretText } from "./secret-text.js";

/**
 * Discovering the OpenAI/Codex identity Pi already holds (INV-10, INV-13).
 *
 * Pi owns OAuth: login, refresh, rotation, and the file they live in. Re-implementing any of that
 * here would fork a credential lifecycle and create a second place where a refresh token can leak,
 * so this module prefers Pi's own published accessor and only falls back to a read-only structural
 * parse of the same file when Pi is not importable. The fallback is explicitly a *read* of Pi's
 * storage format, not a reimplementation: nothing here writes, refreshes, or deletes.
 *
 * Nothing in this file may expose the worker model to what it reads. The access token is returned as
 * a {@link SecretText}, the refresh token is dropped on the floor, and the only values that leave
 * freely are opaque identifiers and expiry timestamps.
 */

/** Pi's credential store key for the ChatGPT/Codex OAuth login. */
export const PI_OPENAI_PROVIDER_ID = "openai-codex" as const;

/** How the agent directory is chosen; mirrors Pi's own `getAgentDir()` for the fallback path. */
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * The stored credential shapes this module understands, structurally identical to Pi's `Credential`.
 *
 * Declared locally on purpose: depending on Pi's internal types at build time would couple this
 * package to a path Pi has not promised to stabilise. `parseStoredCredential` is where that
 * assumption is checked, so a format change fails loudly at the boundary instead of corrupting
 * identity interpretation downstream.
 */
export type PiStoredCredential =
  | { readonly type: "oauth"; readonly access: string; readonly expires: number; readonly accountId?: string }
  | { readonly type: "api_key"; readonly key?: string };

export type PiCredentialRead =
  | {
      readonly ok: true;
      /** `undefined` means "Pi has no OpenAI credential", which is a normal state, not a failure. */
      readonly credential: PiOpenAiCredential | undefined;
      readonly via: PiCredentialSource;
    }
  | { readonly ok: false; readonly failure: PiCredentialFailure };

export type PiCredentialSource =
  /** Pi's published `readStoredCredential` accessor: the preferred path. */
  | "pi-api"
  /** Read-only parse of Pi's auth.json because the Pi package was not importable. */
  | "auth-file"
  /** Supplied by a caller (test harness, another extension host, or an injected store). */
  | "injected";

export type PiCredentialFailure =
  | "pi-package-unavailable"
  | "auth-file-missing"
  | "auth-file-unreadable"
  | "auth-file-malformed"
  | "credential-shape-unrecognised";

/**
 * A Pi-side OpenAI credential, with secrets wrapped and non-transport material discarded.
 *
 * The refresh token is intentionally absent. This extension never refreshes Pi's OAuth; if it held
 * a refresh token it would eventually be obliged to use it, and two writers to one credential is how
 * tokens get invalidated mid-session.
 */
export type PiOpenAiCredential =
  | {
      readonly kind: "oauth";
      readonly accessToken: SecretText;
      /** Epoch milliseconds, from the store (not from the JWT), so expiry is readable without parsing. */
      readonly expiresAt: number;
      /** Opaque ChatGPT account id when Pi stored one; the primary identity signal. */
      readonly accountId?: string;
    }
  | {
      readonly kind: "api-key";
      readonly apiKey: SecretText;
    };

export interface PiCredentialReaderOptions {
  /** Override the auth.json location; defaults to Pi's own agent directory. */
  readonly authPath?: string;
  /**
   * Loader for Pi's package. Injectable so tests cover the `pi-api` path without installing Pi, and
   * so a future Pi version can be probed before adoption.
   */
  readonly loadPiModule?: () => Promise<PiCredentialAccessor>;
  /** Read override for tests. */
  readonly readFile?: (path: string) => Promise<string>;
}

/** The subset of Pi's public surface this module uses. */
export interface PiCredentialAccessor {
  readStoredCredential?(providerId: string, authPath?: string): unknown;
  getAuthPath?(): string;
}

/** Default `auth.json` location: `PI_CODING_AGENT_DIR` or `~/.pi/agent/auth.json`. */
export function defaultPiAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env[PI_AGENT_DIR_ENV];
  return join(agentDir && agentDir.length > 0 ? agentDir : join(homedir(), ".pi", "agent"), "auth.json");
}

/**
 * Read the Pi-side OpenAI credential.
 *
 * Preference order is a correctness property: Pi's accessor resolves env-var credentials and performs
 * no writes, and it is the only view that stays correct if the on-disk format changes. An explicit
 * `authPath` inverts that order — see the branch below.
 */
export async function readPiOpenAiCredential(
  options: PiCredentialReaderOptions = {},
): Promise<PiCredentialRead> {
  const loadModule =
    options.loadPiModule ??
    (async (): Promise<PiCredentialAccessor> => {
      // A variable specifier keeps this package free of a build-time dependency on Pi's internals;
      // `@earendil-works/pi-coding-agent` is present at runtime because this code loads *inside* Pi.
      const specifier = "@earendil-works/pi-coding-agent";
      return (await import(specifier)) as PiCredentialAccessor;
    });

  let module: PiCredentialAccessor | undefined;
  let moduleUnavailable = false;
  try {
    module = await loadModule();
  } catch {
    moduleUnavailable = true;
    module = undefined;
  }

  // An explicit path means "read exactly this file", so the Pi accessor is skipped: its second argument
  // is not honoured as a file path, and passing one would silently return the *default* credential (or
  // none) while claiming to have read the file the caller named. That is worst in tests and in the
  // status surface, where a wrong-but-plausible answer is worse than an error.
  if (options.authPath === undefined && module !== undefined && typeof module.readStoredCredential === "function") {
    const authPath = options.authPath ?? tryGetPiAuthPath(module);
    const raw = readSafely(() => module?.readStoredCredential?.(PI_OPENAI_PROVIDER_ID, authPath));
    if (raw === READ_THREW) {
      return { ok: false, failure: "auth-file-unreadable" };
    }
    if (raw === undefined) return { ok: true, credential: undefined, via: "pi-api" };
    const parsed = parseStoredCredential(raw);
    if (parsed === undefined) return { ok: false, failure: "credential-shape-unrecognised" };
    return { ok: true, credential: parsed, via: "pi-api" };
  }

  // No usable Pi accessor: read the file Pi owns, strictly read-only.
  const authPath = options.authPath ?? defaultPiAuthPath();
  const read = options.readFile ?? ((path: string) => import("node:fs/promises").then((fs) => fs.readFile(path, "utf8")));
  let text: string;
  try {
    text = await read(authPath);
  } catch (error) {
    return { ok: false, failure: classifyFileError(error, moduleUnavailable) };
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { ok: false, failure: "auth-file-malformed" };
  }
  if (typeof document !== "object" || document === null) {
    return { ok: false, failure: "auth-file-malformed" };
  }
  const entry = (document as Record<string, unknown>)[PI_OPENAI_PROVIDER_ID];
  if (entry === undefined || entry === null) return { ok: true, credential: undefined, via: "auth-file" };

  const parsed = parseStoredCredential(entry);
  if (parsed === undefined) return { ok: false, failure: "credential-shape-unrecognised" };
  return { ok: true, credential: parsed, via: "auth-file" };
}

/**
 * Turn one auth.json entry into a {@link PiOpenAiCredential}, or `undefined` when the shape is not
 * recognised.
 *
 * Exported because it is the single place the storage format is assumed; a Pi format change must show
 * up here as a rejection rather than as a half-populated identity.
 */
export function parseStoredCredential(entry: unknown): PiOpenAiCredential | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  if (record["type"] === "oauth") {
    const access = record["access"];
    const expires = record["expires"];
    if (typeof access !== "string" || access.length === 0) return undefined;
    if (typeof expires !== "number" || !Number.isFinite(expires)) return undefined;
    const accountId = record["accountId"];
    return {
      kind: "oauth",
      accessToken: SecretText.from(access),
      expiresAt: expires,
      ...(typeof accountId === "string" && accountId.length > 0 ? { accountId } : {}),
    };
  }
  if (record["type"] === "api_key") {
    const key = record["key"];
    // A key command (`key: "!cmd"`) resolves at Pi's transport layer; without executing it we have
    // no material, and executing arbitrary configured commands here is not acceptable.
    if (typeof key !== "string" || key.length === 0 || key.startsWith("!")) return undefined;
    return { kind: "api-key", apiKey: SecretText.from(key) };
  }
  return undefined;
}

const READ_THREW = Symbol("read-threw");

function readSafely(fn: () => unknown): unknown {
  try {
    return fn();
  } catch {
    return READ_THREW;
  }
}

function tryGetPiAuthPath(module: PiCredentialAccessor): string | undefined {
  try {
    return typeof module.getAuthPath === "function" ? module.getAuthPath() : undefined;
  } catch {
    return undefined;
  }
}

function classifyFileError(error: unknown, moduleUnavailable: boolean): PiCredentialFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "ENOENT") return moduleUnavailable ? "pi-package-unavailable" : "auth-file-missing";
  return "auth-file-unreadable";
}
