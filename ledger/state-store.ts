/**
 * Durable-state primitives: crash-safe JSON/JSONL writes and advisory locks (INV-15).
 *
 * Three properties are load-bearing for everything above this module:
 *
 * - **No torn state.** Every rewrite goes through a private temporary file plus an atomic `rename`, so a
 *   process killed mid-write leaves either the previous file or the new one, never half of either. A
 *   ledger or mapping file that has to be repaired by hand is a provenance hole (INV-15).
 * - **Nothing world-readable.** Files are 0600 and directories 0700, using the same primitive the
 *   browser profile uses, because these files carry consultation provenance and Project/conversation ids.
 * - **Corruption is reported, never papered over.** A file that parses as JSON but not as the expected
 *   shape is `state-corrupt`; silently starting from an empty store would recreate a ChatGPT Project that
 *   already exists (INV-08) and forget live conversations (INV-09).
 *
 * Locks are advisory and same-host only, which is exactly the scale V1 runs at: one machine, possibly two
 * Pi sessions. Project/conversation mapping deliberately holds its keyed lock across the bounded browser
 * probe because inspection plus create/adopt is one read-modify-write decision.
 */

import { constants, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";

import { assertPrivateDirectory, PRIVATE_DIR_MODE, writePrivateFileNoFollow } from "../browser/state-storage.js";

export type StateStoreFailureCode = "state-corrupt" | "state-unreadable" | "state-busy";

export class StateStoreError extends Error {
  readonly code: StateStoreFailureCode;
  readonly path: string;

  constructor(code: StateStoreFailureCode, path: string, message: string) {
    super(message);
    this.name = "StateStoreError";
    this.code = code;
    this.path = path;
  }
}

/** Injectable so the store logic is testable without touching a real filesystem. */
export interface StateStoreFileSystem {
  readonly mkdirPrivate: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string | undefined>;
  /** List direct children of a managed directory. */
  readonly readDirectory: (path: string) => Promise<readonly string[]>;
  readonly writeFilePrivate: (path: string, data: string) => Promise<void>;
  /** Create a private file only when no file already exists; used for lock acquisition. */
  readonly createFilePrivate: (path: string, data: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly appendFile: (path: string, data: string) => Promise<void>;
  /** Symbolic link at `path`? Writes refuse to land on one. */
  readonly isSymlink: (path: string) => Promise<boolean>;
  /** Modification time in epoch milliseconds, `undefined` when the path does not exist. */
  readonly modifiedAt: (path: string) => Promise<number | undefined>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export const nodeStateStore: StateStoreFileSystem = {
  mkdirPrivate: async (path) => {
    await mkdir(path, { mode: PRIVATE_DIR_MODE, recursive: true });
    // `mkdir` ignores the mode of a directory that already exists, so privacy has to be asserted after.
    await assertPrivateDirectory(path, {
      directoryMode: async (target) => {
        try {
          return (await stat(target)).mode & 0o777;
        } catch {
          return undefined;
        }
      },
    });
  },
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  },
  readDirectory: async (path) => {
    try {
      return await readdir(path);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  },
  writeFilePrivate: (path, data) => writePrivateFileNoFollow(path, data),
  createFilePrivate: async (path, data) => {
    const noFollow = typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW > 0;
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (noFollow ? constants.O_NOFOLLOW : 0);
    const handle = await open(path, flags, 0o600);
    try {
      await handle.writeFile(data, "utf8");
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  appendFile: async (path, data) => {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
    try {
      await handle.appendFile(data);
    } finally {
      await handle.close();
    }
  },
  isSymlink: async (path) => {
    try {
      return (await lstat(path)).isSymbolicLink();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  },
  modifiedAt: async (path) => {
    try {
      return (await stat(path)).mtimeMs;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** Create the directory and prove it is owner-only before anything is written into it. */
export async function ensurePrivateDirectory(
  path: string,
  fileSystem: StateStoreFileSystem = nodeStateStore,
): Promise<void> {
  await fileSystem.mkdirPrivate(path);
}

export type JsonReadResult<T> =
  | { readonly ok: true; readonly value: T | undefined }
  | { readonly ok: false; readonly code: Exclude<StateStoreFailureCode, "state-busy">; readonly path: string };

/**
 * Read a JSON state file. `undefined` means "absent" (a first run); a present-but-unparseable or
 * shape-mismatched file is an error, and `parse` is where the caller's shape check lives.
 */
export async function readJsonFile<T>(
  path: string,
  parse: (raw: unknown) => T | undefined,
  fileSystem: StateStoreFileSystem = nodeStateStore,
): Promise<JsonReadResult<T>> {
  let text: string | undefined;
  try {
    if (await fileSystem.isSymlink(path)) {
      return { ok: false, code: "state-corrupt", path };
    }
    text = await fileSystem.readFile(path);
  } catch {
    return { ok: false, code: "state-unreadable", path };
  }
  if (text === undefined) return { ok: true, value: undefined };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "state-corrupt", path };
  }
  const value = parse(raw);
  if (value === undefined) return { ok: false, code: "state-corrupt", path };
  return { ok: true, value };
}

/**
 * Replace a state file atomically: private temp file in the same directory, then `rename`.
 *
 * The temp file must live beside the target — `rename` across filesystems is not atomic — and must be
 * private, because a world-readable moment is a leak that outlives the crash.
 */
export async function writeJsonFileAtomically(
  path: string,
  value: unknown,
  fileSystem: StateStoreFileSystem = nodeStateStore,
): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`, fileSystem);
}

/**
 * Replace a private text file atomically: write a private sibling and then rename it over the
 * destination. This is the JSONL counterpart to `writeJsonFileAtomically`; keeping the primitive
 * here prevents callers from accidentally using a truncating write for a state rewrite.
 */
export async function writeFileAtomically(
  path: string,
  text: string,
  fileSystem: StateStoreFileSystem = nodeStateStore,
): Promise<void> {
  if (await fileSystem.isSymlink(path)) {
    throw new StateStoreError("state-corrupt", path, `Refusing to write state through the symlink "${path}".`);
  }
  const tempPath = `${path}.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await fileSystem.writeFilePrivate(tempPath, text);
  try {
    await fileSystem.rename(tempPath, path);
  } catch (error) {
    await fileSystem.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** Append one JSONL record; the ledger is append-oriented so a partial write cannot lose history. */
export async function appendJsonLine(
  path: string,
  record: unknown,
  fileSystem: StateStoreFileSystem = nodeStateStore,
): Promise<void> {
  await fileSystem.appendFile(path, `${JSON.stringify(record)}\n`);
}

export interface StateLock {
  readonly path: string;
  release(): Promise<void>;
}

export interface StateLockOptions {
  readonly path: string;
  readonly fileSystem?: StateStoreFileSystem;
  /** A lock older than this is presumed to be a crashed process's leftovers and is broken. */
  readonly staleAfterMs?: number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export const DEFAULT_LOCK_STALE_AFTER_MS = 60_000;
// Project reconciliation holds this lock while it performs bounded browser navigation (up to 45s).
// A 15s wait let a healthy concurrent initializer report state-busy before that operation could finish.
export const DEFAULT_LOCK_TIMEOUT_MS = 90_000;
export const DEFAULT_LOCK_POLL_MS = 50;

/**
 * Take an advisory lock, waiting up to `timeoutMs`.
 *
 * Creation is `O_EXCL`, so two processes cannot both believe they hold it. A lock whose mtime is older
 * than `staleAfterMs` is broken only when its recorded owner is absent or no longer alive: the alternative
 * is one crashed Pi session permanently wedging the Project mapping. A live owner is allowed to exceed the
 * age threshold because browser reconciliation is intentionally bounded by a separate timeout; this also
 * prevents a desuspended process from later releasing a lock that a stale-breaker already handed to another
 * writer.
 */
export async function acquireStateLock(
  options: StateLockOptions,
): Promise<StateLock> {
  const fileSystem = options.fileSystem ?? nodeStateStore;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const deadline = fileSystem.now() + timeoutMs;
  const lockContents = `${JSON.stringify({
    pid: process.pid,
    takenAt: new Date(fileSystem.now()).toISOString(),
    nonce: Math.random().toString(36).slice(2),
  })}\n`;

  for (;;) {
    try {
      await fileSystem.createFilePrivate(options.path, lockContents);
      return {
        path: options.path,
        release: async () => {
          // A process can be descheduled after its lock is broken and reacquired by another writer. Only
          // remove the file if it is still the exact lock this acquisition created; an unconditional unlink
          // would let the old owner release the new owner's lock (INV-08/INV-09).
          let current: string | undefined;
          try {
            current = await fileSystem.readFile(options.path);
          } catch {
            return;
          }
          if (current !== lockContents) return;
          await fileSystem.unlink(options.path).catch(() => undefined);
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const modifiedAt = await fileSystem.modifiedAt(options.path);
      const age = modifiedAt === undefined ? timeoutMs : fileSystem.now() - modifiedAt;
      const owner = await readLockOwner(fileSystem, options.path);
      const stillSameFile = modifiedAt !== undefined && (await fileSystem.modifiedAt(options.path)) === modifiedAt;
      if (stillSameFile && age >= staleAfterMs && owner !== null && (owner === undefined || !isProcessAlive(owner))) {
        await fileSystem.unlink(options.path).catch(() => undefined);
        continue;
      }
      if (fileSystem.now() >= deadline) {
        throw new StateStoreError(
          "state-busy",
          options.path,
          `Another pi-with-chatgpt process holds ${options.path}; retry once it finishes.`,
        );
      }
      await fileSystem.sleep(pollMs);
    }
  }
}

/** Lock file name for a branded key: stable, path-safe, and never derived from user prose. */
export function lockFilePath(locksDir: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
  return `${locksDir}/${safe}.lock`;
}

export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST";
}

async function readLockOwner(fileSystem: StateStoreFileSystem, path: string): Promise<number | null | undefined> {
  try {
    const contents = await fileSystem.readFile(path);
    if (contents === undefined) return undefined;
    const value = JSON.parse(contents) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
  } catch {
    // An unreadable lock is not evidence that its owner is dead; waiting is safer than breaking it.
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}
