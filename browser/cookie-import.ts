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
 *
 * Copying a person's real session is the most sensitive touch in the product, so it is gated twice:
 * {@link authorizeChromeStateImport} mints the human authorization that {@link applyChromeStateImport}
 * requires and cannot be reconstructed from data, and the plan refuses paths that would move bytes
 * outside the pair of directories the human was shown.
 */

import { chmod, copyFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AdviserProfile } from "./profile.js";
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  assertPrivateDirectory,
  writePrivateFileNoFollow,
} from "./state-storage.js";

/** Where a source file lives relative to, inside the user's Chromium installation. */
export type ChromeStateScope = "profile" | "userDataDir";

export interface ChromeStateFileSpec {
  /** Path relative to the scope root. Never absolute, never escaping with `..`. */
  readonly relativePath: string;
  readonly scope: ChromeStateScope;
  readonly required: boolean;
  /** Why this file is in the minimum set; surfaced in the UI so the copy is explainable. */
  readonly reason: string;
  /**
   * `Local State` is copied as a scrubbed copy rather than byte for byte: it is a single JSON
   * document holding account metadata for *every* profile in the source install, and only the
   * `os_crypt` key reference is needed to open the cookie database. Scrubbing is declared here so the
   * allowlist stays the single statement of what may move.
   */
  readonly scrub?: "account-metadata";
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
    scrub: "account-metadata",
  },
];

/**
 * Paths inside `Local State` that are dropped from the copy (INV-12 data minimization).
 *
 * The blast radius of copying the file whole was the finding: `account_info` and
 * `profile.info_cache` describe *every* signed-in Google account in the source install — email,
 * GAIA id, given/family name, picture — not just the profile being imported, and they would then sit
 * in a second directory indefinitely. None of it is needed to open a cookie database.
 *
 * `os_crypt.encrypted_key` is scrubbed on Linux and macOS, where the key material actually lives in
 * libsecret/Keychain and the file only carries a reference. On Windows it *is* the key (DPAPI-wrapped)
 * and dropping it would make the import read as logged out, so it is left in place there; Windows is
 * post-V1 and has no automated coverage.
 */
export const LOCAL_STATE_SCRUB_PATHS: readonly (readonly string[])[] = [
  ["account_info"],
  ["profile", "info_cache"],
  ["profile", "last_account_id"],
  ["profile", "metrics", "service_worker_registration_id"],
  ["browser", "shortcuts", "command_shortcuts"],
];

/** Extra paths scrubbed everywhere except Windows, where the value is the key itself. */
export const LOCAL_STATE_KEY_REFERENCE_PATHS: readonly (readonly string[])[] = [["os_crypt", "encrypted_key"]];

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
  /** Set when the file is written as a scrubbed copy rather than copied byte for byte. */
  readonly scrub?: "account-metadata";
}

/** The source the human was shown, retained so an authorization cannot be replayed onto another plan. */
export interface ChromeStateImportSource {
  readonly userDataDir: string;
  readonly profileDirectoryName: string;
  readonly profileDirectory: string;
}

export type ChromeStateImportPlan =
  | {
      readonly ok: true;
      readonly entries: readonly ChromeStateImportEntry[];
      readonly copiedPaths: readonly string[];
      readonly skippedOptionalPaths: readonly string[];
      readonly profile: AdviserProfile;
      readonly source: ChromeStateImportSource;
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
  // The profile directory name is the only part of the source that a caller may compose, and it is
  // attacker-influenced in the realistic case (a listing read from `Local State`, a config override).
  // Containment was previously asserted on `sourceUserDataDir` alone, which let `../` walk the resolved
  // profile directory anywhere on disk — including back into the extension's own profile, defeating the
  // self-import guard below.
  const profileDirectoryName = normalizeRelative(request.sourceProfileDirectoryName);
  if (profileDirectoryName === undefined) {
    return refused(
      "unsafe-source-path",
      `profile directory name "${request.sourceProfileDirectoryName}" is not a single relative directory name`,
    );
  }

  const sourceUserDataDir = request.sourceUserDataDir;
  const sourceRoots = {
    userDataDir: sourceUserDataDir,
    profile: join(sourceUserDataDir, profileDirectoryName),
  };

  const sourceIsInsideDestination =
    isWithin(request.profile.userDataDir, sourceUserDataDir) ||
    isWithin(request.profile.userDataDir, sourceRoots.profile);
  if (sourceIsInsideDestination) {
    return refused("source-is-extension-profile", "the source profile is inside the extension-owned state");
  }
  if (
    sourceUserDataDir === request.profile.userDataDir ||
    normalizeSlashes(sourceRoots.profile) === normalizeSlashes(request.profile.userDataDir)
  ) {
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
    const sourcePath = join(sourceRoots[spec.scope], relative);
    const destinationPath = join(request.profile.userDataDir, relative);
    // Defence in depth for the composition above: every resolved path must still sit inside the pair of
    // directories the human was shown, so a future change to either root cannot silently move bytes
    // somewhere else.
    if (!isWithin(sourceUserDataDir, sourcePath)) {
      return refused("unsafe-source-path", `resolved source "${sourcePath}" escaped "${sourceUserDataDir}"`);
    }
    if (!isWithin(request.profile.userDataDir, destinationPath)) {
      return refused(
        "unsafe-source-path",
        `resolved destination "${destinationPath}" escaped the adviser profile directory`,
      );
    }
    entries.push({
      sourcePath,
      destinationPath,
      relativePath: relative,
      required: spec.required,
      present,
      reason: spec.reason,
      ...(spec.scrub === undefined ? {} : { scrub: spec.scrub }),
    });
  }

  return {
    ok: true,
    entries,
    copiedPaths: entries.filter((entry) => entry.present).map((entry) => entry.relativePath),
    skippedOptionalPaths: entries.filter((entry) => !entry.present).map((entry) => entry.relativePath),
    profile: request.profile,
    source: {
      userDataDir: sourceUserDataDir,
      profileDirectoryName,
      profileDirectory: sourceRoots.profile,
    },
  };
}

/**
 * Proof that a human authorised one specific copy.
 *
 * `import-chrome-state` is in `MANUAL_INTERVENTION_ACTIONS`, but a name in a list is not a gate: a
 * caller that never consults the list still copies the cookies. The gate is a value the extension
 * cannot synthesize from data it read — `humanConfirmed` is the literal `true`, so minting one means a
 * call site had to write the literal down, which is greppable, reviewable, and impossible to reach by
 * plumbing a config or a server response through it. The fingerprint binds the token to the source and
 * destination it was minted for, so approving `Profile 1` cannot authorize `Default`.
 */
export interface ChromeStateImportAuthorization {
  readonly kind: "human-authorized";
  readonly planFingerprint: string;
  /** For the audit record; never an account identifier. */
  readonly sourceProfileDirectoryName: string;
}

/**
 * The phrase a call site has to write down to mint an authorization.
 *
 * A boolean cannot carry intent: `humanConfirmed: someFlag` type-checks against anything and lets a
 * detection result or a config default become the confirmation. A distinctive literal makes every call
 * site greppable, so `rg -n "confirmedByHuman"` is a complete audit of who may import. It is a gate,
 * not a cryptographic barrier — a caller written *deliberately to bypass it* can cast — and its value
 * is that no amount of ordinary plumbing reaches it by accident.
 */
export const HUMAN_IMPORT_CONFIRMATION = "pi-with-chatgpt:human-confirmed-chrome-state-import" as const;

export type HumanImportConfirmation = typeof HUMAN_IMPORT_CONFIRMATION;

/** Mint an authorization. Throws unless the caller stated the confirmation phrase. */
export function authorizeChromeStateImport(
  plan: Extract<ChromeStateImportPlan, { ok: true }>,
  confirmation: { readonly confirmedByHuman: HumanImportConfirmation },
): ChromeStateImportAuthorization {
  if (confirmation === undefined || confirmation.confirmedByHuman !== HUMAN_IMPORT_CONFIRMATION) {
    throw new Error(
      "import-chrome-state requires the explicit human confirmation phrase (INV-11); a value computed from detection results or configuration is not one",
    );
  }
  return {
    kind: "human-authorized",
    planFingerprint: fingerprintPlan(plan),
    sourceProfileDirectoryName: plan.source.profileDirectoryName,
  };
}

export class ChromeStateImportError extends Error {
  /**
   * `not-authorized` and `authorization-for-other-plan` are programming errors; `source-unscrubbable`
   * is a real-world condition (a `Local State` that is not valid JSON). They are kept apart because a
   * caller that reports "you did not confirm this" for a file it merely could not parse sends the user
   * looking for a dialog they already answered.
   */
  readonly reason: "not-authorized" | "authorization-for-other-plan" | "source-unscrubbable";
  readonly detail: string;

  constructor(reason: ChromeStateImportError["reason"], detail: string) {
    super(detail);
    this.name = "ChromeStateImportError";
    this.reason = reason;
    this.detail = detail;
  }
}

function fingerprintPlan(plan: Extract<ChromeStateImportPlan, { ok: true }>): string {
  return [
    plan.source.userDataDir,
    plan.source.profileDirectoryName,
    plan.profile.userDataDir,
    plan.entries.filter((entry) => entry.present).map((entry) => entry.relativePath).join(","),
  ].join("\u0000");
}

export interface ImportFileSystem {
  readonly statSize: (path: string) => Promise<number | undefined>;
  readonly copy: (source: string, destination: string) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly mkdir: (path: string, mode: number) => Promise<void>;
  readonly readHeader: (path: string, byteLength: number) => Promise<string | undefined>;
  /** Read a whole text file (for the scrubbed `Local State` copy). */
  readonly readText: (path: string) => Promise<string | undefined>;
  /** Write owner-only without following a planted symlink. */
  readonly writePrivate: (path: string, data: string) => Promise<void>;
  /** Directory mode, for the privacy assertion on the destination. */
  readonly directoryMode: (path: string) => Promise<number | undefined>;
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
  readText: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
  writePrivate: async (path, data) => {
    await writePrivateFileNoFollow(path, data, PRIVATE_FILE_MODE);
  },
  directoryMode: async (path) => {
    try {
      return (await stat(path)).mode & 0o777;
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

/**
 * Copy the planned files and return what landed.
 *
 * Two guards run before any byte moves. The authorization is required by the signature, so a caller
 * cannot forget it, and re-checked at runtime, so it cannot be forged from a `null` or a stale token.
 * The destination profile directory is created and then *measured*: `mkdir` ignores the mode of a
 * directory that already exists, so a profile directory someone else had created group-readable would
 * otherwise hold copied cookies while every call in this sequence reported success.
 */
export async function applyChromeStateImport(
  plan: Extract<ChromeStateImportPlan, { ok: true }>,
  authorization: ChromeStateImportAuthorization,
  fileSystem: ImportFileSystem = nodeImportFileSystem,
): Promise<readonly string[]> {
  if (authorization === undefined || authorization === null || authorization.kind !== "human-authorized") {
    throw new ChromeStateImportError(
      "not-authorized",
      "applyChromeStateImport requires a human authorization minted by authorizeChromeStateImport; importing reads the user's real browser profile (INV-11)",
    );
  }
  if (authorization.planFingerprint !== fingerprintPlan(plan)) {
    throw new ChromeStateImportError(
      "authorization-for-other-plan",
      `the confirmation was given for a different import than the one being applied (profile "${authorization.sourceProfileDirectoryName}")`,
    );
  }

  await fileSystem.mkdir(plan.profile.userDataDir, PRIVATE_DIR_MODE);
  await assertPrivateDirectory(plan.profile.userDataDir, fileSystem);

  const copied: string[] = [];
  for (const entry of plan.entries) {
    if (!entry.present) continue;
    if (entry.scrub === "account-metadata") {
      const text = await fileSystem.readText(entry.sourcePath);
      const scrubbed = text === undefined ? undefined : scrubChromeLocalState(text);
      if (scrubbed === undefined) {
        // Without a parseable document there is no way to know what the copy would expose, so
        // minimization cannot be honoured: refuse rather than copy something unexamined.
        throw new ChromeStateImportError(
          "source-unscrubbable",
          `"${entry.relativePath}" could not be read as JSON, so its account metadata could not be removed before copying`,
        );
      }
      await fileSystem.writePrivate(entry.destinationPath, scrubbed.text);
    } else {
      await fileSystem.copy(entry.sourcePath, entry.destinationPath);
    }
    await fileSystem.chmod(entry.destinationPath, PRIVATE_FILE_MODE);
    copied.push(entry.relativePath);
  }
  return copied;
}

export type LocalStateScrub = {
  readonly ok: true;
  readonly text: string;
  /** Dotted paths actually removed, for the provenance record. */
  readonly removed: readonly string[];
} | { readonly ok: false };

/**
 * Remove account metadata from a `Local State` document.
 *
 * Everything that is not on the denylist is preserved verbatim: the file also carries the OS-key
 * reference and the encryption/versioning state Chromium needs to open the cookie database, and
 * rewriting those would import as logged out. Returns `ok: false` when the document does not parse,
 * which the caller treats as a refusal rather than a licence to copy the original.
 */
export function scrubChromeLocalState(
  text: string,
  options: { readonly os?: NodeJS.Platform } = {},
): Extract<LocalStateScrub, { ok: true }> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const document = structuredClone(parsed) as Record<string, unknown>;
  const paths = [...LOCAL_STATE_SCRUB_PATHS];
  if ((options.os ?? process.platform) !== "win32") paths.push(...LOCAL_STATE_KEY_REFERENCE_PATHS);

  const removed: string[] = [];
  for (const path of paths) if (deleteAtPath(document, path)) removed.push(path.join("."));
  return { ok: true, text: JSON.stringify(document), removed };
}

function deleteAtPath(root: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (typeof current !== "object" || current === null) return false;
    current = (current as Record<string, unknown>)[path[index] ?? ""];
  }
  if (typeof current !== "object" || current === null) return false;
  const leaf = path[path.length - 1] ?? "";
  if (!(leaf in (current as Record<string, unknown>))) return false;
  delete (current as Record<string, unknown>)[leaf];
  return true;
}

export interface ImportedFileCheck {
  readonly relativePath: string;
  readonly expectedSize: number;
  readonly actualSize: number | undefined;
  readonly header: string | undefined;
  /** Written as a scrubbed copy: size cannot match the source, so minimization is asserted instead. */
  readonly scrubbed: boolean;
  /** Parsed copy of a scrubbed file's contents, when it is one. */
  readonly scrubbedDocument?: unknown;
}

export type ImportVerification =
  | { readonly ok: true; readonly checked: readonly string[] }
  | {
      readonly ok: false;
      readonly failure: "size-mismatch" | "not-a-sqlite-database" | "missing-copy" | "unscrubbed-account-metadata";
      readonly detail: string;
    };

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
 * Three checks, none of them decryption: the copied file has the same size as its source, the cookie
 * database still carries the SQLite magic header, and a scrubbed `Local State` no longer carries any of
 * the account-metadata paths. A torn or truncated copy — the realistic failure when Chrome was running
 * — is caught here instead of appearing later as a puzzling "not logged in".
 */
export function checkImportedFiles(checks: readonly ImportedFileCheck[]): ImportVerification {
  for (const check of checks) {
    if (check.actualSize === undefined) {
      return { ok: false, failure: "missing-copy", detail: check.relativePath };
    }
    if (!check.scrubbed && check.actualSize !== check.expectedSize) {
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
    if (check.scrubbed) {
      const leaked = scrubbedPathsPresent(check.scrubbedDocument);
      if (leaked.length > 0) {
        return {
          ok: false,
          failure: "unscrubbed-account-metadata",
          detail: `${check.relativePath} still carries ${leaked.join(", ")}`,
        };
      }
    }
  }
  return { ok: true, checked: checks.map((check) => check.relativePath) };
}

/** Which denylist paths are still present in a document that should have had them removed. */
export function scrubbedPathsPresent(document: unknown, os: NodeJS.Platform = process.platform): string[] {
  const paths = [...LOCAL_STATE_SCRUB_PATHS];
  if (os !== "win32") paths.push(...LOCAL_STATE_KEY_REFERENCE_PATHS);
  const present: string[] = [];
  for (const path of paths) if (hasAtPath(document, path)) present.push(path.join("."));
  return present;
}

function hasAtPath(root: unknown, path: readonly string[]): boolean {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return false;
    if (!(segment in (current as Record<string, unknown>))) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

/** Read source and destination facts for a plan, for {@link checkImportedFiles}. */
export async function collectImportChecks(
  plan: Extract<ChromeStateImportPlan, { ok: true }>,
  fileSystem: ImportFileSystem = nodeImportFileSystem,
): Promise<ImportedFileCheck[]> {
  const checks: ImportedFileCheck[] = [];
  for (const entry of plan.entries) {
    if (!entry.present) continue;
    const scrubbed = entry.scrub === "account-metadata";
    const destinationText = scrubbed ? await fileSystem.readText(entry.destinationPath) : undefined;
    checks.push({
      relativePath: entry.relativePath,
      expectedSize: (await fileSystem.statSize(entry.sourcePath)) ?? -1,
      actualSize: await fileSystem.statSize(entry.destinationPath),
      header: await fileSystem.readHeader(entry.destinationPath, SQLITE_HEADER.length),
      scrubbed,
      ...(destinationText === undefined ? {} : { scrubbedDocument: safeParse(destinationText) }),
    });
  }
  return checks;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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

function normalizeRelative(path: string): string | undefined {
  if (path.length === 0 || path.startsWith("/") || path.startsWith("\\")) return undefined;
  const segments = path.replace(/\\/gu, "/").split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment.length === 0)) return undefined;
  return segments.join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const normalize = (value: string): string => normalizeSlashes(value).replace(/\/+$/u, "");
  return normalize(candidate) === normalize(root) || normalize(candidate).startsWith(`${normalize(root)}/`);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

function refused(failure: ImportFailure, detail: string): ChromeStateImportPlan {
  return { ok: false, failure, detail };
}
