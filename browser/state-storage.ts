/**
 * Extension-owned browser state location and its permissions (INV-11, INV-12).
 *
 * Everything the adviser browser persists — cookies, Local Storage, imported Chrome state — lives
 * below one directory inside Pi's agent directory, never inside the repository and never inside a
 * browser profile the user works in. Three properties matter and all are enforced here rather than
 * left to the caller:
 *
 *   1. the location is derived from Pi's agent directory (or an explicit override),
 *   2. every created directory is `0700` and every written file `0600`, and
 *   3. ownership is *proven* by a marker and never inferred from a directory name, so a tree the
 *      extension did not create is refused rather than adopted.
 *
 * Filesystem operations are injected so the rules are testable without touching the real home
 * directory. The security-relevant write ({@link writePrivateFileNoFollow}) is deliberately the one
 * operation the injected seam cannot weaken: it is exercised against a real filesystem.
 */

import { constants, chmod as fsChmod, lstat, mkdir as fsMkdir, open, writeFile as fsWriteFile } from "node:fs/promises";
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

/** Bits that would let anyone other than the owner read cookie or credential material. */
const ACCESS_TO_OTHERS = 0o077;

/** Why a state-tree operation refused. Stable strings; safe to log and to assert on. */
export type StateStorageRefusal =
  /** The tree existed but does not carry our ownership marker, so it is not ours to use. */
  | "state-tree-not-owned"
  /** A directory that holds cookies is group- or world-accessible and could not be made private. */
  | "directory-not-private"
  /** The write target is a symlink; following it could redirect cookie material outside the tree. */
  | "symlink-refused";

export class StateStorageError extends Error {
  readonly reason: StateStorageRefusal;
  readonly path: string;

  constructor(reason: StateStorageRefusal, path: string, message: string) {
    super(message);
    this.name = "StateStorageError";
    this.reason = reason;
    this.path = path;
  }
}

export interface StateStorageFileSystem {
  readonly mkdir: (path: string, options: { mode: number; recursive?: boolean }) => Promise<unknown>;
  readonly chmod: (path: string, mode: number) => Promise<unknown>;
  /**
   * Write a private file without following a symlink at the target. The default implementation is
   * {@link writePrivateFileNoFollow}; tests may substitute it but production never does.
   */
  readonly writePrivateFile: (path: string, data: string, mode: number) => Promise<void>;
  /** Existing directory's permission bits, or `undefined` when absent or unstatable. */
  readonly directoryMode: (path: string) => Promise<number | undefined>;
  /** Whether a path exists at all, without following a final symlink. */
  readonly pathExists: (path: string) => Promise<boolean>;
}

/**
 * Whether a mode grants access to anyone but its owner.
 *
 * Chromium does not tighten an existing profile directory, so importing into or creating a profile in
 * a group- or world-readable directory would leave copied cookies readable by other accounts.
 */
export function modeGrantsAccessToOthers(mode: number): boolean {
  return (mode & ACCESS_TO_OTHERS) !== 0;
}

/**
 * Write `path` owner-only, refusing to follow a symlink that is already there.
 *
 * `O_EXCL` makes creation atomic (no truncate-then-write window another process can plant through) and
 * `O_NOFOLLOW` makes a planted symlink an error instead of a redirected write — the kernel returns
 * `ELOOP`, or `EPERM` on the platforms that report it that way. The mode is applied again with `chmod`
 * because the mode argument to `open` is masked by the process umask.
 *
 * `O_NOFOLLOW` does not exist on every platform (`0` on Windows, which is post-V1); an `lstat` check
 * covers that case so the guarantee never silently disappears.
 */
export async function writePrivateFileNoFollow(
  path: string,
  data: string,
  mode: number = PRIVATE_FILE_MODE,
): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW > 0;
  const exclusive = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (noFollow ? constants.O_NOFOLLOW : 0);
  const replace = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (noFollow ? constants.O_NOFOLLOW : 0);

  try {
    await writeWith(open, path, data, exclusive, mode);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      // A private file we wrote earlier: replace it, still without following a symlink.
      try {
        await writeWith(open, path, data, replace, mode);
      } catch (replaceError) {
        throw symlinkRefusal(replaceError, path, noFollow);
      }
      await chmodQuietly(path, mode);
      return;
    }
    throw symlinkRefusal(error, path, noFollow);
  }
  if (!noFollow && (await isSymlink(path))) throw new StateStorageError("symlink-refused", path, symlinkMessage(path));
  await chmodQuietly(path, mode);
}

function symlinkRefusal(error: unknown, path: string, noFollow: boolean): unknown {
  const code = errorCode(error);
  if (code === "ELOOP" || code === "EPERM") return new StateStorageError("symlink-refused", path, symlinkMessage(path));
  return error;
}

function symlinkMessage(path: string): string {
  return `refusing to write "${path}": the target is a symlink, and following it could place cookie material outside the extension-owned state tree`;
}

async function writeWith(
  opener: typeof open,
  path: string,
  data: string,
  flags: number,
  mode: number,
): Promise<void> {
  const handle = await opener(path, flags, mode);
  try {
    await handle.writeFile(data, "utf8");
  } finally {
    await handle.close();
  }
}

async function chmodQuietly(path: string, mode: number): Promise<void> {
  try {
    await fsChmod(path, mode);
  } catch {
    // A filesystem without POSIX modes must not turn a completed write into an unexplained failure.
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
}

const nodeFileSystem: StateStorageFileSystem = {
  mkdir: (path, options) => fsMkdir(path, options),
  chmod: (path, mode) => fsChmod(path, mode),
  writePrivateFile: async (path, data, mode) => {
    await writePrivateFileNoFollow(path, data, mode);
  },
  directoryMode: async (path) => {
    try {
      return (await lstat(path)).mode & 0o777;
    } catch {
      return undefined;
    }
  },
  pathExists: async (path) => {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  },
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
  /** Directories that already existed; their modes are reported, never changed silently. */
  readonly preexisting: readonly string[];
}

/**
 * Create the state tree with owner-only permissions and drop the ownership markers.
 *
 * Two rules decide every filesystem call, and both exist because a directory mode is not a detail:
 *
 *   - **A tree we did not create is refused, not adopted.** If `browserRoot` exists without our
 *     `OWNER` marker, something else put it there, and taking it over would mean writing session
 *     cookies into a directory that may be someone else's — or that another tool watches. The marker
 *     is checked *before* any `chmod`, so refusing cannot leave a side effect behind.
 *   - **A directory we do not own never has its mode changed.** `stateRoot` is normally Pi's own
 *     `~/.pi/agent`, which pre-exists and is Pi's to permission. Tightening it here would be an
 *     unrequested write to another program's directory, so ancestors are left alone and only the
 *     subtree below `browserRoot` is made private.
 *
 * Modes are set again after `mkdir` because `mkdir`'s mode is masked by the process umask and ignored
 * for directories that already exist.
 */
export async function prepareStateStorage(
  paths: StateStoragePaths,
  fileSystem: StateStorageFileSystem = nodeFileSystem,
): Promise<PreparedStateDirs> {
  const markerPath = join(paths.browserRoot, STATE_OWNER_MARKER);
  const browserRootExists = await fileSystem.pathExists(paths.browserRoot);
  if (browserRootExists && !(await fileSystem.pathExists(markerPath))) {
    throw new StateStorageError(
      "state-tree-not-owned",
      paths.browserRoot,
      `"${paths.browserRoot}" already exists without the ${STATE_OWNER_MARKER} marker that proves this extension created it. Refusing to adopt it: writing session cookies into a directory that is not ours would expose them to whoever can read that tree. Remove the directory or point PI_CODING_AGENT_DIR elsewhere.`,
    );
  }

  const directories = [paths.stateRoot, paths.browserRoot, paths.profileDir, paths.chromeImportDir];
  const created: string[] = [];
  const preexisting: string[] = [];
  // Only the subtree below browserRoot is ours to permission; ancestors (Pi's agent directory) are not.
  const owned = new Set([paths.browserRoot, paths.profileDir, paths.chromeImportDir]);

  for (const directory of directories) {
    const existed = await fileSystem.pathExists(directory);
    if (!existed) {
      await fileSystem.mkdir(directory, { mode: PRIVATE_DIR_MODE, recursive: true });
    }
    if (!existed || owned.has(directory)) {
      await fileSystem.chmod(directory, PRIVATE_DIR_MODE);
    }
    (existed ? preexisting : created).push(directory);

    // Enforce, do not merely intend: a group-readable directory holding cookies stays readable after a
    // successful mkdir/chmod (an ACL or a filesystem without POSIX modes can both defeat the request),
    // so the mode actually on disk is re-read and refused if it still grants access.
    const mode = await fileSystem.directoryMode(directory);
    if (mode !== undefined && modeGrantsAccessToOthers(mode) && owned.has(directory)) {
      throw new StateStorageError(
        "directory-not-private",
        directory,
        `"${directory}" has mode ${(mode & 0o777).toString(8)} and would leave imported cookies readable by other accounts. It must be owner-only (0700).`,
      );
    }
  }

  await fileSystem.writePrivateFile(markerPath, STATE_OWNER_MARKER_CONTENT, PRIVATE_FILE_MODE);
  await fileSystem.writePrivateFile(join(paths.browserRoot, ".gitignore"), STATE_GITIGNORE, PRIVATE_FILE_MODE);
  return { paths, created, preexisting };
}

/** Write a file inside the state tree owner-only, without following a planted symlink. */
export async function writePrivateStateFile(
  path: string,
  content: string,
  fileSystem: StateStorageFileSystem = nodeFileSystem,
): Promise<void> {
  await fileSystem.writePrivateFile(path, content, PRIVATE_FILE_MODE);
}

/**
 * Refuse to use a directory that other accounts can read.
 *
 * Callers that place cookie material into a directory they did not create (the Chrome import
 * destination, most importantly) have to assert the directory is private *after* creating it: `mkdir`
 * silently ignores the mode of a directory that already exists, so a profile directory created earlier
 * by another tool could stay group-readable while every call in the sequence reports success.
 */
export async function assertPrivateDirectory(
  path: string,
  fileSystem: Pick<StateStorageFileSystem, "directoryMode">,
): Promise<void> {
  const mode = await fileSystem.directoryMode(path);
  if (mode !== undefined && modeGrantsAccessToOthers(mode)) {
    throw new StateStorageError(
      "directory-not-private",
      path,
      `"${path}" has mode ${(mode & 0o777).toString(8)}; cookie material must live in an owner-only (0700) directory.`,
    );
  }
}
