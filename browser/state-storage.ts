/**
 * Extension-owned browser state location and its permissions (INV-11, INV-12).
 *
 * Everything the adviser browser persists — cookies, Local Storage, imported Chrome state — lives
 * below one directory inside Pi's agent directory, never inside the repository and never inside a
 * browser profile the user works in. Two properties matter and both are enforced here rather than
 * left to the caller:
 *
 *   1. the location is derived from Pi's agent directory (or an explicit override), and
 *   2. every created directory is `0700` and every written file `0600`, with ownership markers that
 *      keep a human (and `git`) from treating the tree as project content.
 *
 * Filesystem operations are injected so the rules are testable without touching the real home
 * directory.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createAdviserProfile, type AdviserProfile } from "./profile.js";

/** Marker file naming the owner of the state tree; also documents it for a human inspector. */
export const STATE_OWNER_MARKER = "OWNER";
export const STATE_OWNER_MARKER_CONTENT =
  "This directory is owned by the pi-with-chatgpt Pi extension.\n" +
  "It holds the isolated ChatGPT adviser browser profile, including session cookies.\n" +
  "It is not project content. Do not commit it, share it, or point a normal browser at it.\n";

/** Cookie material must never be committed by accident, so the tree ignores itself. */
export const STATE_GITIGNORE = "*\n";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export interface StateStorageFileSystem {
  readonly mkdir: (path: string, options: { mode: number; recursive?: boolean }) => Promise<unknown>;
  readonly chmod: (path: string, mode: number) => Promise<unknown>;
  readonly writeFile: (path: string, data: string, options: { mode: number }) => Promise<unknown>;
}

const nodeFileSystem: StateStorageFileSystem = {
  mkdir: (path, options) => mkdir(path, options),
  chmod: (path, mode) => chmod(path, mode),
  writeFile: (path, data, options) => writeFile(path, data, options),
};

export interface StateStoragePaths {
  /** Root the extension owns; everything below is created and permissioned by this module. */
  readonly stateRoot: string;
  readonly browserRoot: string;
  readonly profileDir: string;
  readonly chromeImportDir: string;
  readonly capabilityStateFile: string;
}

/**
 * Resolve the state locations. `PI_CODING_AGENT_DIR` is Pi's own agent-directory override, so honouring
 * it keeps the profile with the rest of the agent's state (including `auth.json`).
 */
export function stateStoragePaths(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
): StateStoragePaths {
  const agentDir = env["PI_CODING_AGENT_DIR"]?.trim() || join(homeDir, ".pi", "agent");
  const browserRoot = join(agentDir, "pi-with-chatgpt", "browser");
  return {
    stateRoot: resolve(agentDir),
    browserRoot,
    profileDir: join(browserRoot, "chatgpt-profile"),
    chromeImportDir: join(browserRoot, "chrome-imports"),
    capabilityStateFile: join(browserRoot, "capability.json"),
  };
}

/**
 * The adviser profile as an {@link AdviserProfile}. Going through `createAdviserProfile` means the
 * INV-11 ownership and "not a user browser" checks cannot be skipped by a caller that only wanted a
 * path string.
 */
export function adviserProfileFor(paths: StateStoragePaths): AdviserProfile {
  return createAdviserProfile({ stateRoot: paths.stateRoot, userDataDir: paths.profileDir });
}

export interface PreparedStateDirs {
  readonly paths: StateStoragePaths;
  readonly created: readonly string[];
}

/**
 * Create the state tree with owner-only permissions and drop the ownership markers.
 *
 * `mkdir` is called with an explicit mode, and the mode is set again afterwards: `mkdir`'s mode is
 * masked by the process umask and ignored for directories that already exist, so a previously
 * created world-readable directory would otherwise stay that way.
 */
export async function prepareStateStorage(
  paths: StateStoragePaths,
  fileSystem: StateStorageFileSystem = nodeFileSystem,
): Promise<PreparedStateDirs> {
  const directories = [paths.stateRoot, paths.browserRoot, paths.profileDir, paths.chromeImportDir];
  const created: string[] = [];
  for (const directory of directories) {
    await fileSystem.mkdir(directory, { mode: PRIVATE_DIR_MODE, recursive: true });
    await fileSystem.chmod(directory, PRIVATE_DIR_MODE);
    created.push(directory);
  }

  await fileSystem.writeFile(join(paths.browserRoot, STATE_OWNER_MARKER), STATE_OWNER_MARKER_CONTENT, {
    mode: PRIVATE_FILE_MODE,
  });
  await fileSystem.writeFile(join(paths.browserRoot, ".gitignore"), STATE_GITIGNORE, {
    mode: PRIVATE_FILE_MODE,
  });
  return { paths, created };
}

/** Write a file inside the state tree with owner-only permissions. */
export async function writePrivateStateFile(
  path: string,
  content: string,
  fileSystem: StateStorageFileSystem = nodeFileSystem,
): Promise<void> {
  await fileSystem.writeFile(path, content, { mode: PRIVATE_FILE_MODE });
  await fileSystem.chmod(path, PRIVATE_FILE_MODE);
}

/**
 * Whether a directory's mode grants access to anyone but its owner.
 *
 * Chromium does not tighten an existing profile directory, so importing into or creating a profile in
 * a group- or world-readable directory would leave copied cookies readable by other accounts. The
 * check is advisory on platforms where the mode is not meaningful (a failed `stat` returns false)
 * rather than a hard failure, and callers should refuse to proceed when it reports `true`.
 */
export function modeGrantsAccessToOthers(mode: number): boolean {
  return (mode & 0o077) !== 0;
}
