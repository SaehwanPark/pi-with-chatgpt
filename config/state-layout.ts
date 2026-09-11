/**
 * The one on-disk layout for everything this extension persists (INV-12, INV-15).
 *
 * Every durable artifact — Project mappings, task conversations, job records, the ledger — lives under
 * a single state root that the extension owns, never inside the workspace: a consultation record in the
 * repository would be a second, unsanctioned channel out of the machine (INV-02) and would leak advice
 * provenance into commits. The layout is declared once here because four modules guessing at path
 * strings is how one module starts reading another's files.
 *
 * The root comes from `browser/state-storage.ts` (`stateStoragePaths()`), so the adviser profile and
 * everything else share one permission and cleanup boundary. This module is pure: it derives names and
 * performs no I/O, which keeps it importable from anywhere.
 */

import { join } from "node:path";

import type { GitHubRepositoryKey } from "../protocol/repo.js";

/** Directory names below the state root. Fixed: renaming one silently orphans existing state. */
export const STATE_DIRECTORY_NAMES = {
  conversations: "conversations",
  jobs: "jobs",
  locks: "locks",
  repositories: "repositories",
  cleanup: "cleanup",
} as const;

/** Files below the state root. */
export const PROJECT_MAPPING_FILE = "projects.json";

/** Files below `repositories/<repo-id>/`, matching `docs/CONSULTATION_PROTOCOL.md`. */
export const LEDGER_FILE_NAME = "consultations.jsonl";
export const RESPONSES_DIRECTORY_NAME = "responses";
export const TASKS_DIRECTORY_NAME = "tasks";

export interface AdviserStateLayout {
  /** The extension-owned root (`~/.pi/agent/pi-with-chatgpt` by default). */
  readonly stateRoot: string;
  /** repo → ChatGPT Project mapping (INV-08). */
  readonly projectMappingFile: string;
  /** One file per task conversation (INV-09). */
  readonly conversationsDir: string;
  /** One file per consultation job, written before dispatch (INV-15). */
  readonly jobsDir: string;
  /** Advisory lock files; contents are diagnostic only, never authority. */
  readonly locksDir: string;
  /** Per-repository ledger roots. */
  readonly repositoriesDir: string;
  /** Trash for the safe-cleanup policy: moves, never in-place deletes across filesystems. */
  readonly cleanupDir: string;
}

export interface RepositoryStateLayout {
  readonly repoId: string;
  readonly dir: string;
  readonly ledgerFile: string;
  readonly responsesDir: string;
  readonly tasksDir: string;
}

export function adviserStateLayout(stateRoot: string): AdviserStateLayout {
  const root = joinUnder(stateRoot, "pi-with-chatgpt");
  return {
    stateRoot: root,
    projectMappingFile: joinUnder(root, PROJECT_MAPPING_FILE),
    conversationsDir: joinUnder(root, STATE_DIRECTORY_NAMES.conversations),
    jobsDir: joinUnder(root, STATE_DIRECTORY_NAMES.jobs),
    locksDir: joinUnder(root, STATE_DIRECTORY_NAMES.locks),
    repositoriesDir: joinUnder(root, STATE_DIRECTORY_NAMES.repositories),
    cleanupDir: joinUnder(root, STATE_DIRECTORY_NAMES.cleanup),
  };
}

/**
 * Filesystem-safe id for a repository.
 *
 * `owner/repo` cannot be a directory name, and a naive `replace("/", "-")` would collide with a
 * repository whose name legitimately contains `-`. Percent-encoding every unsafe character and keeping
 * the shape check strict means two different repositories can never resolve to the same directory.
 */
export function repositoryStateId(repository: GitHubRepositoryKey): string {
  return repository
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("__");
}

export function repositoryStateLayout(
  layout: AdviserStateLayout,
  repository: GitHubRepositoryKey,
): RepositoryStateLayout {
  const repoId = repositoryStateId(repository);
  const dir = joinUnder(layout.repositoriesDir, repoId);
  return {
    repoId,
    dir,
    ledgerFile: joinUnder(dir, LEDGER_FILE_NAME),
    responsesDir: joinUnder(dir, RESPONSES_DIRECTORY_NAME),
    tasksDir: joinUnder(dir, TASKS_DIRECTORY_NAME),
  };
}

/** Conversation and job file names are digests of branded keys: they must be path-safe and stable. */
export function stateFileNameForKey(prefix: string, key: string, extension: string): string {
  const hex = digestHex(key);
  return `${prefix}-${hex}.${extension}`;
}

/** Response files are named by consultation id, which is already `[a-z0-9-]` (INV-12: no user text). */
export function responseFileName(consultationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(consultationId)) {
    throw new Error(`Refusing to derive a response file name from "${consultationId.slice(0, 24)}".`);
  }
  return `${consultationId}.md`;
}

/**
 * A short, stable, filesystem-safe digest.
 *
 * Keys carry repository and task identities; hashing keeps file names bounded and free of user text
 * while staying reproducible across processes. `fnv1a` is used rather than `node:crypto` so this module
 * stays dependency-free; collisions across real repository/task keys are not a security boundary here
 * (the file contents are validated against the key on read).
 */
function digestHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Two rounds over a re-seeded state give 64 bits of spread without any dependency.
  let second = 0x811c9dc5;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    second ^= value.charCodeAt(index);
    second = Math.imul(second, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function joinUnder(base: string, segment: string): string {
  return join(base, segment);
}
