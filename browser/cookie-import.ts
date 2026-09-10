/**
 * Minimum-set Chrome state import (M2).
 *
 * The goal is *session continuity for ChatGPT*, not a mirror of the user's browser. Only the cookie
 * database and the one file Chromium needs to interpret it are copied; history, bookmarks, saved
 * passwords, extensions, cache, and IndexedDB never leave the user's profile. That limit is expressed
 * as an explicit allowlist ({@link MINIMUM_CHATGPT_STATE_FILES}) rather than as an exclusion list, so a
 * new Chrome directory cannot quietly widen what gets copied.
 *
 * Cookies are encrypted at rest with a key held by the operating system (macOS Keychain, Linux
 * libsecret). This module never asks for that key and never decrypts: the copied files are opened by
 * Chromium itself, which is the only process with access. "No decryption path in this extension" is
 * therefore a property of this file, not a promise about it (INV-12).
 */

import { chmod, copyFile, mkdir, open, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AdviserProfile } from "./profile.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./state-storage.js";

/** Where a source file lives relative to, inside the user's Chromium installation. */
export type ChromeStateScope = "profile" | "userDataDir";

export interface ChromeStateFileSpec {
  /** Path relative to the scope root. Never absolute, never escaping with `..`. */
  readonly relativePath: string;
  readonly scope: ChromeStateScope;
  readonly required: boolean;
  /** Why this file is in the minimum set; surfaced in the UI so the copy is explainable. */
  readonly reason: string;
}

/**
 * The complete set of files an imported session may consist of.
 *
 * `Local State` is required because Chromium reads the OS-key reference from it before it can open the
 * cookie database; without it the copy would import as logged out. WAL/SHM are optional sidecars: they
 * exist only while Chrome has unsynced writes, and a WAL left behind without its journal context is
 * harmless, so both are copied when present and skipped when not.
 */
export const MINIMUM_CHATGPT_STATE_FILES: readonly ChromeStateFileSpec[] = [
  {
    relativePath: "Network/Cookies",
    scope: "profile",
    required: true,
    reason: "ChatGPT session cookies",
  },
  {
    relativePath: "Network/Cookies-wal",
    scope: "profile",
    required: false,
    reason: "unflushed cookie writes",
  },
  {
    relativePath: "Network/Cookies-shm",
    scope: "profile",
    required: false,
    reason: "cookie database shared memory header",
  },
  {
    relativePath: "Local State",
    scope: "userDataDir",
    required: true,
    reason: "Chromium OS-key reference needed to open the cookie database",
  },
];

/** SQLite magic header. Present even when the database's contents are encrypted. */
export const SQLITE_HEADER = "SQLite format 3\0";

export type ImportFailure =
  | "source-is-extension-profile"
  | "source-is-destination"
  | "source-browser-running"
  | "required-source-file-missing"
  | "destination-not-empty"
  | "unsafe-source-path";

export interface ChromeStateImportRequest {
  readonly profile: AdviserProfile;
  readonly sourceUserDataDir: string;
  readonly sourceProfileDirectoryName: string;
  /** Files that exist in the source, as paths relative to their scope root. */
  readonly existingSourceFiles: ReadonlySet<string>;
  /** Whether the source browser holds the profile right now. */
  readonly sourceBrowserRunning: boolean;
  /** Relative paths already present in the destination profile. */
  readonly existingDestinationFiles: ReadonlySet<string>;
}

export interface ChromeStateImportEntry {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly relativePath: string;
  readonly required: boolean;
  readonly present: boolean;
  readonly reason: string;
}

export type ChromeStateImportPlan =
  | {
      readonly ok: true;
      readonly entries: readonly ChromeStateImportEntry[];
      readonly copiedPaths: readonly string[];
      readonly skippedOptionalPaths: readonly string[];
      readonly profile: AdviserProfile;
    }
  | { readonly ok: false; readonly failure: ImportFailure; readonly detail: string };

/**
 * Decide exactly which bytes would move, before moving any of them.
 *
 * The refusal cases are the interesting ones: a running source browser can yield a torn cookie
 * database, a missing `Network/Cookies` would import as "logged in nowhere", and a non-empty
 * destination would mix two sessions into one profile with no way to tell which cookies win.
 */
export function planChromeStateImport(request: ChromeStateImportRequest): ChromeStateImportPlan {
  const sourceRoots = {
    userDataDir: request.sourceUserDataDir,
    profile: join(request.sourceUserDataDir, request.sourceProfileDirectoryName),
  };

  if (isWithin(request.profile.userDataDir, request.sourceUserDataDir)) {
    return refused("source-is-extension-profile", "the source profile is inside the extension-owned state");
  }
  if (request.sourceUserDataDir === request.profile.userDataDir) {
    return refused("source-is-destination", "the source and destination profiles are the same directory");
  }
  if (request.sourceBrowserRunning) {
    return refused(
      "source-browser-running",
      "Chromium is running with this profile; close it so the cookie database is copied whole",
    );
  }
  if (!request.existingSourceFiles.has("Network/Cookies")) {
    return refused(
      "required-source-file-missing",
      "the source profile has no cookie database, so it cannot contain a ChatGPT session",
    );
  }
  if (request.existingDestinationFiles.size > 0) {
    return refused(
      "destination-not-empty",
      `the adviser profile already contains ${[...request.existingDestinationFiles]
        .map((path) => basename(path))
        .join(", ")}`,
    );
  }

  const entries: ChromeStateImportEntry[] = [];
  for (const spec of MINIMUM_CHATGPT_STATE_FILES) {
    const relative = normalizeRelative(spec.relativePath);
    if (relative === undefined) {
      return refused("unsafe-source-path", `state path "${spec.relativePath}" is not a safe relative path`);
    }
    const present = request.existingSourceFiles.has(relative);
    if (spec.required && !present) {
      return refused("required-source-file-missing", `${relative} is required but absent`);
    }
    entries.push({
      sourcePath: join(sourceRoots[spec.scope], relative),
      destinationPath: join(request.profile.userDataDir, relative),
      relativePath: relative,
      required: spec.required,
      present,
      reason: spec.reason,
    });
  }

  return {
    ok: true,
    entries,
    copiedPaths: entries.filter((entry) => entry.present).map((entry) => entry.relativePath),
    skippedOptionalPaths: entries.filter((entry) => !entry.present).map((entry) => entry.relativePath),
    profile: request.profile,
  };
}

export interface ImportFileSystem {
  readonly statSize: (path: string) => Promise<number | undefined>;
  readonly copy: (source: string, destination: string) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly mkdir: (path: string, mode: number) => Promise<void>;
  readonly readHeader: (path: string, byteLength: number) => Promise<string | undefined>;
}

const nodeImportFileSystem: ImportFileSystem = {
  statSize: async (path) => {
    try {
      return (await stat(path)).size;
    } catch {
      return undefined;
    }
  },
  copy: async (source, destination) => {
    await mkdir(dirname(destination), { recursive: true, mode: PRIVATE_DIR_MODE });
    await copyFile(source, destination);
    await chmodSafe(destination, PRIVATE_FILE_MODE);
  },
  chmod: async (path, mode) => {
    await chmodSafe(path, mode);
  },
  mkdir: async (path, mode) => {
    await mkdir(path, { recursive: true, mode });
  },
  readHeader: async (path, byteLength) => {
    try {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(byteLength);
        const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
        return buffer.subarray(0, bytesRead).toString("latin1");
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  },
};

async function chmodSafe(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // A filesystem without POSIX modes (or a file that vanished) must not turn a successful copy into
    // an unexplained failure; verification reports what is actually on disk.
  }
}

/** Copy the planned files and return what landed. */
export async function applyChromeStateImport(
  plan: Extract<ChromeStateImportPlan, { ok: true }>,
  fileSystem: ImportFileSystem = nodeImportFileSystem,
): Promise<readonly string[]> {
  await fileSystem.mkdir(plan.profile.userDataDir, PRIVATE_DIR_MODE);
  const copied: string[] = [];
  for (const entry of plan.entries) {
    if (!entry.present) continue;
    await fileSystem.copy(entry.sourcePath, entry.destinationPath);
    copied.push(entry.relativePath);
  }
  return copied;
}

export interface ImportedFileCheck {
  readonly relativePath: string;
  readonly expectedSize: number;
  readonly actualSize: number | undefined;
  readonly header: string | undefined;
}

export type ImportVerification =
  | { readonly ok: true; readonly checked: readonly string[] }
  | { readonly ok: false; readonly failure: "size-mismatch" | "not-a-sqlite-database" | "missing-copy"; readonly detail: string };

/**
 * Verify a plan against what is actually on disk, before Chromium is launched.
 *
 * The wrapper exists so a caller cannot forget the collection step and "verify" an empty list.
 */
export async function verifyChromeStateImport(
  plan: Extract<ChromeStateImportPlan, { ok: true }>,
  fileSystem: ImportFileSystem = nodeImportFileSystem,
): Promise<ImportVerification> {
  return checkImportedFiles(await collectImportChecks(plan, fileSystem));
}

/**
 * Confirm the collected facts match what was intended.
 *
 * Two checks, both cheap and neither of them decryption: the copied file has the same size as its
 * source, and the cookie database still carries the SQLite magic header. A torn or truncated copy —
 * the realistic failure when Chrome was running — is caught here instead of appearing later as a
 * puzzling "not logged in".
 */
export function checkImportedFiles(checks: readonly ImportedFileCheck[]): ImportVerification {
  for (const check of checks) {
    if (check.actualSize === undefined) {
      return { ok: false, failure: "missing-copy", detail: check.relativePath };
    }
    if (check.actualSize !== check.expectedSize) {
      return {
        ok: false,
        failure: "size-mismatch",
        detail: `${check.relativePath}: copied ${String(check.actualSize)} of ${String(check.expectedSize)} bytes`,
      };
    }
    if (basename(check.relativePath) === "Cookies" && check.header !== undefined) {
      if (!check.header.startsWith(SQLITE_HEADER)) {
        return { ok: false, failure: "not-a-sqlite-database", detail: check.relativePath };
      }
    }
  }
  return { ok: true, checked: checks.map((check) => check.relativePath) };
}

/** Read source and destination facts for a plan, for {@link checkImportedFiles}. */
export async function collectImportChecks(
  plan: Extract<ChromeStateImportPlan, { ok: true }>,
  fileSystem: ImportFileSystem = nodeImportFileSystem,
): Promise<ImportedFileCheck[]> {
  const checks: ImportedFileCheck[] = [];
  for (const entry of plan.entries) {
    if (!entry.present) continue;
    checks.push({
      relativePath: entry.relativePath,
      expectedSize: (await fileSystem.statSize(entry.sourcePath)) ?? -1,
      actualSize: await fileSystem.statSize(entry.destinationPath),
      header: await fileSystem.readHeader(entry.destinationPath, SQLITE_HEADER.length),
    });
  }
  return checks;
}

/** Remove an imported file set after a failed verification, so a half-import is never used. */
export async function discardImportedState(
  plan: Extract<ChromeStateImportPlan, { ok: true }>,
  fileSystem: { readonly remove: (path: string) => Promise<void> },
): Promise<void> {
  for (const entry of plan.entries) {
    if (entry.present) await fileSystem.remove(entry.destinationPath);
  }
}

/** Write a marker recording that this profile was seeded by import rather than by manual login. */
export async function writeImportMarker(
  plan: Extract<ChromeStateImportPlan, { ok: true }>,
  content: string,
  fileSystem: { readonly write: (path: string, data: string) => Promise<void> },
): Promise<void> {
  await fileSystem.write(join(plan.profile.userDataDir, "IMPORTED-FROM-CHROME"), content);
}

export async function writeFileSafe(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
  await writeFile(path, content, { mode: PRIVATE_FILE_MODE });
}

function normalizeRelative(path: string): string | undefined {
  if (path.length === 0 || path.startsWith("/") || path.startsWith("\\")) return undefined;
  const segments = path.replace(/\\/gu, "/").split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment.length === 0)) return undefined;
  return segments.join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return normalize(candidate) === normalize(root) || normalize(candidate).startsWith(`${normalize(root)}/`);
}

function refused(failure: ImportFailure, detail: string): ChromeStateImportPlan {
  return { ok: false, failure, detail };
}
