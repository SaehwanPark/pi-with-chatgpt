/**
 * Read-only detection of Chromium-family installs and their profiles (M2).
 *
 * This module is deliberately capable of *reading* only: it lists installs, reads the plaintext
 * `Local State` file, and reports whether a profile looks busy. It never opens a cookie database and
 * never decrypts anything — encrypted ChatGPT cookies are made usable by handing the copied file to
 * Chromium itself, which holds the platform key (macOS Keychain, Linux libsecret). Keeping decryption
 * out of this extension is what makes the "no decrypt path" guarantee checkable (INV-12).
 */

import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type ChromiumFamily = "chrome" | "chromium" | "brave" | "edge";

/** What Chromium reports about an account in a profile. */
export interface ChromeAccountRef {
  /** Chrome's account identifier when available; see {@link accountRefFor} for the fallback. */
  readonly id: string;
  readonly email?: string;
  readonly name?: string;
  readonly userName?: string;
  readonly lastUsed?: string;
}

/** One `profile.info_cache` entry: enough to show a human a choice, nothing private. */
export interface ChromeProfileInfo {
  readonly name?: string;
  readonly userName?: string;
  readonly email?: string;
  readonly gaiaId?: string;
  readonly lastUsed?: string;
}

export interface ChromeProfileRef {
  /** Directory name inside the user-data-dir, e.g. `Default` or `Profile 1`. */
  readonly directoryName: string;
  readonly userDataDir: string;
  readonly displayName?: string;
  readonly accounts: readonly ChromeAccountRef[];
  /**
   * True when Chromium holds this profile right now. Copying a busy cookie database can capture a
   * half-written state, so callers must surface this rather than proceed silently.
   */
  readonly lockedByRunningBrowser: boolean;
  /** `Local State` existed and parsed; when false the account list is simply unknown.
   * Absence is reported as "unknown", never as "no accounts". */
  readonly stateReadable: boolean;
  readonly rejection?: "local-state-missing" | "local-state-malformed";
}

export interface ChromiumInstallRef {
  readonly family: ChromiumFamily;
  /** Platform directory that acts as Chromium's default `--user-data-dir`. */
  readonly userDataDir: string;
  readonly present: true;
  readonly profiles: readonly ChromeProfileRef[];
}

export interface BrowserStateSources {
  readonly installs: readonly ChromiumInstallRef[];
  readonly platform: NodeJS.Platform;
}

export interface BrowserStateSourceFileSystem {
  readonly readFile: (path: string) => Promise<string>;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly statExists: (path: string) => Promise<boolean>;
  readonly readlinkExists: (path: string) => Promise<boolean>;
}

const nodeFileSystem: BrowserStateSourceFileSystem = {
  readFile: async (path) => (await readFile(path)).toString("utf8"),
  readdir: async (path) => await readdir(path),
  statExists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  readlinkExists: async (path) => {
    try {
      await readlink(path);
      return true;
    } catch {
      return false;
    }
  },
};

const FAMILIES: ChromiumFamily[] = ["chrome", "chromium", "brave", "edge"];

/**
 * User-data-dir candidates per family and platform.
 *
 * macOS and Linux only. Windows is out of V1 scope (see docs/ARCHITECTURE.md “Platform claim”), and
 * the deliberate behaviour there is an empty list: discovery reports no installs and the flow offers
 * manual login, rather than guessing at a layout nothing in CI exercises.
 */
function userDataDirCandidates(
  family: ChromiumFamily,
  os: NodeJS.Platform,
  homeDir: string,
): string[] {
  const layout = {
    chrome: { darwin: "Library/Application Support/Google/Chrome", linux: ".config/google-chrome" },
    chromium: { darwin: "Library/Application Support/Chromium", linux: ".config/chromium" },
    brave: {
      darwin: "Library/Application Support/BraveSoftware/Brave-Browser",
      linux: ".config/BraveSoftware/Brave-Browser",
    },
    edge: { darwin: "Library/Application Support/Microsoft Edge", linux: ".config/microsoft-edge" },
  }[family];

  if (os === "darwin") return [join(homeDir, layout.darwin)];
  if (os !== "linux") return [];
  return family === "chromium"
    ? [join(homeDir, layout.linux), join(homeDir, ".config/chromium-browser")]
    : [join(homeDir, layout.linux)];
}

/**
 * Enumerate Chromium-family installs and their profiles.
 *
 * Nothing here is fatal: an absent or unreadable directory simply yields no install or a profile-level
 * rejection. A user with no Chrome at all is an ordinary case handled by manual login, so discovery
 * must never throw.
 */
export async function detectBrowserStateSources(
  options: {
    readonly homeDir?: string;
    readonly os?: NodeJS.Platform;
    readonly fileSystem?: BrowserStateSourceFileSystem;
  } = {},
): Promise<BrowserStateSources> {
  const homeDir = options.homeDir ?? homedir();
  const os = options.os ?? platform();
  const fileSystem = options.fileSystem ?? nodeFileSystem;

  const installs: ChromiumInstallRef[] = [];
  for (const family of FAMILIES) {
    for (const userDataDir of userDataDirCandidates(family, os, homeDir)) {
      if (!(await fileSystem.statExists(userDataDir))) continue;
      installs.push({ family, userDataDir, present: true, profiles: await readProfiles(userDataDir, fileSystem) });
    }
  }
  return { installs, platform: os };
}

async function readProfiles(
  userDataDir: string,
  fileSystem: BrowserStateSourceFileSystem,
): Promise<ChromeProfileRef[]> {
  // Chromium creates the singleton link while running and removes it on clean exit.
  const browserRunning = await fileSystem.readlinkExists(join(userDataDir, "SingletonLock"));

  let entries: string[];
  try {
    entries = await fileSystem.readdir(userDataDir);
  } catch {
    return [];
  }

  const profiles: ChromeProfileRef[] = [];
  for (const entry of entries) {
    if (entry !== "Default" && !/^Profile \d+$/u.test(entry)) continue;
    profiles.push(await readProfile(userDataDir, entry, browserRunning, fileSystem));
  }
  return profiles;
}

async function readProfile(
  userDataDir: string,
  directoryName: string,
  browserRunning: boolean,
  fileSystem: BrowserStateSourceFileSystem,
): Promise<ChromeProfileRef> {
  let text: string;
  try {
    text = await fileSystem.readFile(join(userDataDir, "Local State"));
  } catch {
    return {
      directoryName,
      userDataDir,
      accounts: [],
      lockedByRunningBrowser: browserRunning,
      stateReadable: false,
      rejection: "local-state-missing",
    };
  }

  const infoCache = parseChromeLocalState(text);
  if (infoCache === undefined) {
    return {
      directoryName,
      userDataDir,
      accounts: [],
      lockedByRunningBrowser: browserRunning,
      stateReadable: false,
      rejection: "local-state-malformed",
    };
  }

  const info = infoCache[directoryName];
  return {
    directoryName,
    userDataDir,
    ...(info?.name === undefined && info?.userName === undefined
      ? {}
      : { displayName: info.name ?? info.userName }),
    accounts: info === undefined ? [] : [accountRefFor(directoryName, info)],
    lockedByRunningBrowser: browserRunning,
    stateReadable: true,
  };
}

/**
 * Read the account list out of `Local State`.
 *
 * The list lives in the plaintext `profile.info_cache` map. Anything encrypted — cookies, saved
 * passwords, the encryption key — is intentionally not looked at here.
 */
export function parseChromeLocalState(text: string): Record<string, ChromeProfileInfo> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const rawInfoCache = recordAt(parsed as Record<string, unknown>, ["profile", "info_cache"]);
  const infoCache: Record<string, ChromeProfileInfo> = {};
  for (const [key, value] of Object.entries(rawInfoCache ?? {})) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    infoCache[key] = {
      ...optionalField(entry, "name", "name"),
      ...optionalField(entry, "user_name", "userName"),
      ...optionalField(entry, "email", "email"),
      ...optionalField(entry, "gaia_id", "gaiaId"),
      ...optionalField(entry, "last_used", "lastUsed"),
    };
  }
  return infoCache;
}

function accountRefFor(profileDirectoryName: string, info: ChromeProfileInfo): ChromeAccountRef {
  return {
    // Chrome exposes no stable per-account id in info_cache besides gaia_id; falling back to the
    // profile directory keeps the reference unique within this install.
    id: info.gaiaId ?? `${profileDirectoryName}:info`,
    ...(info.email === undefined ? {} : { email: info.email }),
    ...(info.name === undefined ? {} : { name: info.name }),
    ...(info.userName === undefined ? {} : { userName: info.userName }),
    ...(info.lastUsed === undefined ? {} : { lastUsed: info.lastUsed }),
  };
}

function optionalField(
  source: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, string> {
  const value = source[from];
  return typeof value === "string" && value.length > 0 ? { [to]: value } : {};
}

function recordAt(state: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  let current: unknown = state;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "object" && current !== null ? (current as Record<string, unknown>) : undefined;
}
