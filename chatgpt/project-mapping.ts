/**
 * Repository → ChatGPT Project mapping (INV-08).
 *
 * One Project per GitHub repository, keyed by the canonical `owner/repo` — never by branch, task, Pi
 * session, or worktree, because those vary per run and would multiply Projects for the same repository.
 * The mapping is local state, written before a Project is ever reported as usable (INV-15), and it is the
 * only place that gets to say "this repository's Project is X".
 *
 * Two failures are designed out rather than handled:
 *
 * - **Duplicates.** Creation happens under a per-state-root lock, after an inspection pass, and a create
 *   that loses a race *adopts* the Project that appeared instead of failing. Two Pi sessions pointing at
 *   one repository therefore converge on one Project.
 * - **Loss of provenance.** An inconclusive probe (network, challenge page) never destroys a mapping. The
 *   mapping is only replaced when the surface *proves* the Project is gone, so a flaky network cannot
 *   orphan a week of conversations.
 */

import type { AdviserProjectSurface } from "../browser/runtime-types.js";
import type { AdviserStateLayout } from "../config/state-layout.js";
import type { GitHubRepositoryKey } from "../protocol/repo.js";
import type { StateStoreFileSystem } from "../ledger/state-store.js";
import { assertCredentialFreeValue } from "../ledger/record.js";
import {
  acquireStateLock,
  ensurePrivateDirectory,
  lockFilePath,
  nodeStateStore,
  readJsonFile,
  writeJsonFileAtomically,
} from "../ledger/state-store.js";
import { projectTitleForRepository } from "./project-instructions.js";
import { projectKeyForRepository, type ChatGptProjectKey } from "./scope.js";

/** On-disk schema version: bumped by a migration, never by a silent reparse. */
export const PROJECT_MAPPING_SCHEMA_VERSION = 1;

export interface ChatGptProjectMapping {
  readonly repository: GitHubRepositoryKey;
  readonly projectKey: ChatGptProjectKey;
  /** The ChatGPT Project id. Opaque to us; never parsed, never a URL. */
  readonly projectId: string;
  /** Canonical URL retained for operator navigation; the id remains authoritative. */
  readonly projectUrl?: string;
  readonly projectTitle: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Monotonic per write; a stale writer's update is rejected rather than trusted. */
  readonly revision: number;
  /** Diagnostics only: how often the remote title disagreed with ours, and how often we rebuilt. */
  readonly renameCount: number;
  readonly recreateCount: number;
  /** False until the V1 instructions have actually been written to the Project. */
  readonly instructionsApplied: boolean;
  /** Last transition, as a closed vocabulary — never free prose, never a page dump. */
  readonly lastEvent: ProjectMappingEvent;
}

export const PROJECT_MAPPING_EVENTS = [
  "created",
  "adopted",
  "reused",
  "renamed",
  "recreated",
  "instructions-applied",
  "inspection-unknown",
] as const;
export type ProjectMappingEvent = (typeof PROJECT_MAPPING_EVENTS)[number];

export interface ProjectMappingFile {
  readonly version: number;
  readonly projects: Readonly<Record<string, ChatGptProjectMapping>>;
}

export const EMPTY_PROJECT_MAPPING_FILE: ProjectMappingFile = { version: PROJECT_MAPPING_SCHEMA_VERSION, projects: {} };

export type ProjectRefusalReason =
  | "state-corrupt"
  | "state-unreadable"
  | "state-busy"
  | "needs-human"
  | "create-failed"
  | "surface-unrecognised"
  | "provider-error"
  | "browser-lost";

export type EnsureProjectOutcome = "reused" | "adopted" | "created" | "renamed" | "recreated";

export type EnsureProjectResult =
  | {
      readonly ok: true;
      readonly outcome: EnsureProjectOutcome;
      readonly mapping: ChatGptProjectMapping;
      readonly instructionsApplied: boolean;
      /** Set when the remote Project disagreed with the mapping in a recoverable way. */
      readonly note?: string;
    }
  | { readonly ok: false; readonly reason: ProjectRefusalReason; readonly explanation: string };

export interface EnsureProjectDependencies {
  readonly layout: AdviserStateLayout;
  readonly repository: GitHubRepositoryKey;
  readonly surface: AdviserProjectSurface;
  readonly instructions: string;
  readonly fileSystem?: StateStoreFileSystem;
  readonly now?: () => Date;
}

/** Deterministic key derivation, exposed so callers cannot invent a second one. */
export function projectKeyFor(repository: GitHubRepositoryKey): ChatGptProjectKey {
  return projectKeyForRepository(repository);
}

export function parseProjectMappingFile(raw: unknown): ProjectMappingFile | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const candidate = raw as { version?: unknown; projects?: unknown };
  if (candidate.version !== PROJECT_MAPPING_SCHEMA_VERSION) return undefined;
  if (typeof candidate.projects !== "object" || candidate.projects === null || Array.isArray(candidate.projects)) {
    return undefined;
  }
  const projects: Record<string, ChatGptProjectMapping> = {};
  for (const [key, value] of Object.entries(candidate.projects as Record<string, unknown>)) {
    const mapping = parseProjectMapping(value);
    // A record we cannot interpret is corruption, not an entry to skip: skipping would silently drop a
    // repository's Project and invite a duplicate on next use.
    if (mapping === undefined || mapping.projectKey !== key) return undefined;
    projects[key] = mapping;
  }
  return { version: PROJECT_MAPPING_SCHEMA_VERSION, projects };
}

function parseProjectMapping(value: unknown): ChatGptProjectMapping | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const strings = ["repository", "projectKey", "projectId", "projectTitle", "createdAt", "updatedAt"] as const;
  for (const field of strings) {
    if (typeof record[field] !== "string" || (record[field]).trim().length === 0) return undefined;
  }
  if (!isOpaqueId(record.projectId as string)) return undefined;
  if (record.projectUrl !== undefined && !isCanonicalProjectUrl(record.projectUrl)) return undefined;
  if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 1) return undefined;
  if (typeof record.renameCount !== "number" || typeof record.recreateCount !== "number") return undefined;
  if (typeof record.instructionsApplied !== "boolean") return undefined;
  if (!PROJECT_MAPPING_EVENTS.includes(record.lastEvent as ProjectMappingEvent)) return undefined;
  const mapping = value as ChatGptProjectMapping;
  if (projectKeyForRepository(mapping.repository) !== mapping.projectKey) return undefined;
  // A mapping file that somehow acquired credential-shaped material is refused before it is read further.
  try {
    assertCredentialFreeValue("project mapping", mapping);
  } catch {
    return undefined;
  }
  return mapping;
}

export interface ProjectMappingRead {
  readonly file: ProjectMappingFile;
  /** Set when the file on disk could not be trusted; callers must surface it, never overwrite silently. */
  readonly corrupt: boolean;
}

export async function readProjectMappingFile(
  layout: AdviserStateLayout,
  fileSystem: StateStoreFileSystem = nodeStateStore,
): Promise<ProjectMappingRead> {
  const result = await readJsonFile<ProjectMappingFile>(
    layout.projectMappingFile,
    parseProjectMappingFile,
    fileSystem,
  );
  if (!result.ok) return { file: EMPTY_PROJECT_MAPPING_FILE, corrupt: true };
  return { file: result.value ?? EMPTY_PROJECT_MAPPING_FILE, corrupt: false };
}

export async function listProjectMappings(
  layout: AdviserStateLayout,
  fileSystem: StateStoreFileSystem = nodeStateStore,
): Promise<readonly ChatGptProjectMapping[]> {
  const { file } = await readProjectMappingFile(layout, fileSystem);
  return Object.values(file.projects);
}

/**
 * Make sure this repository has exactly one Project, and that we know its id.
 *
 * Ordering is the point: read under lock → inspect the live surface → create or adopt only when the
 * inspection proves creation is needed → persist → release → return. Returning a Project that is not on
 * disk would let a crash produce an orphan the next session duplicates.
 */
export async function ensureProjectForRepository(
  dependencies: EnsureProjectDependencies,
): Promise<EnsureProjectResult> {
  const fileSystem = dependencies.fileSystem ?? nodeStateStore;
  const now = dependencies.now ?? (() => new Date());
  const key = projectKeyFor(dependencies.repository);
  const title = projectTitleForRepository(dependencies.repository);

  try {
    await ensurePrivateDirectory(dependencies.layout.locksDir, fileSystem);
  } catch (error) {
    return { ok: false, reason: stateReason(error), explanation: stateExplanation(error) };
  }
  let lock;
  try {
    lock = await acquireStateLock({ path: lockFilePath(dependencies.layout.locksDir, "projects"), fileSystem });
  } catch (error) {
    return { ok: false, reason: stateReason(error), explanation: stateExplanation(error) };
  }

  try {
    const read = await readProjectMappingFile(dependencies.layout, fileSystem);
    if (read.corrupt) {
      return {
        ok: false,
        reason: "state-corrupt",
        explanation: `The Project mapping file at ${dependencies.layout.projectMappingFile} is unreadable and was not overwritten; repair it before consulting the adviser.`,
      };
    }
    const existing = read.file.projects[key];

    if (existing !== undefined) {
      return await reconcileExisting({ ...dependencies, fileSystem, now }, key, existing, title);
    }
    return await createOrAdopt({ ...dependencies, fileSystem, now }, key, title, read.file, 0);
  } finally {
    await lock.release();
  }
}

interface Context {
  readonly layout: AdviserStateLayout;
  readonly repository: GitHubRepositoryKey;
  readonly surface: AdviserProjectSurface;
  readonly instructions: string;
  readonly fileSystem: StateStoreFileSystem;
  readonly now: () => Date;
}

/**
 * Reconcile a recorded Project against the live surface.
 *
 * `present` refreshes the title if someone renamed it (the id is what identifies a Project, so a rename
 * is metadata, not a broken mapping). `gone` is the only state that justifies a replacement. `unknown`
 * keeps the mapping and reports the uncertainty.
 */
async function reconcileExisting(
  context: Context,
  key: ChatGptProjectKey,
  existing: ChatGptProjectMapping,
  expectedTitle: string,
): Promise<EnsureProjectResult> {
  const inspection = await context.surface.inspectProject(existing.projectId);
  const stamped = (event: ProjectMappingEvent, patch: Partial<ChatGptProjectMapping>): ChatGptProjectMapping => ({
    ...existing,
    ...patch,
    projectKey: key,
    lastEvent: event,
    revision: existing.revision + 1,
    updatedAt: context.now().toISOString(),
  });

  if (inspection.state === "unknown") {
    const mapping = stamped("inspection-unknown", {
      projectUrl: existing.projectUrl ?? canonicalProjectUrl(existing.projectId),
    });
    const persisted = await persist(context, key, mapping);
    if (!persisted.ok) return persisted.refusal;
    return {
      ok: true,
      outcome: "reused",
      mapping,
      instructionsApplied: existing.instructionsApplied,
      note: `ChatGPT could not confirm the Project (${inspection.reason}); keeping the recorded mapping rather than recreating it.`,
    };
  }

  if (inspection.state === "present") {
    const renamed = inspection.title.trim() !== existing.projectTitle.trim();
    const mapping = renamed
      ? stamped("renamed", {
          projectTitle: inspection.title,
          projectUrl: inspection.projectUrl ?? existing.projectUrl ?? canonicalProjectUrl(existing.projectId),
          renameCount: existing.renameCount + 1,
        })
      : stamped("reused", {
          projectUrl: inspection.projectUrl ?? existing.projectUrl ?? canonicalProjectUrl(existing.projectId),
        });
    const persisted = await persist(context, key, mapping);
    if (!persisted.ok) return persisted.refusal;
    const applied = await applyInstructionsIfNeeded(context, mapping);
    if (applied !== mapping) {
      const instructionPersisted = await persist(context, key, applied);
      if (!instructionPersisted.ok) return instructionPersisted.refusal;
    }
    return {
      ok: true,
      outcome: renamed ? "renamed" : "reused",
      mapping: applied,
      instructionsApplied: applied.instructionsApplied,
      ...(renamed
        ? { note: `Project was renamed to "${inspection.title}" remotely; the recorded Project id was kept.` }
        : {}),
    };
  }

  // The surface proved it is gone: rebuild it in place and keep counting, so the operator can see that
  // provenance for older consultations points at a Project that no longer exists.
  const created = await context.surface.createProject({ title: expectedTitle, instructions: context.instructions });
  if (!created.ok) return { ok: false, reason: createReason(created.reason), explanation: createExplanation(created.reason) };
  const mapping = stamped("recreated", {
    projectId: created.projectId,
    projectUrl: created.projectUrl,
    projectTitle: created.title,
    recreateCount: existing.recreateCount + 1,
    instructionsApplied: created.instructionsApplied,
  });
  const persisted = await persist(context, key, mapping);
  if (!persisted.ok) return persisted.refusal;
  return {
    ok: true,
    outcome: "recreated",
    mapping,
    instructionsApplied: mapping.instructionsApplied,
    note: `The Project was deleted; a replacement was created. Older consultations keep their original checkpoint provenance.`,
  };
}

/** First use: adopt an existing Project with our title if one is there, otherwise create one. */
async function createOrAdopt(
  context: Context,
  key: ChatGptProjectKey,
  title: string,
  file: ProjectMappingFile,
  attempt: number,
): Promise<EnsureProjectResult> {
  const listed = await context.surface.listProjects();
  if (!listed.ok) return { ok: false, reason: listed.reason, explanation: createExplanation(listed.reason) };
  const existing = listed.projects.find((project) => project.title.trim() === title.trim());
  if (existing !== undefined) {
    return persistCreated(context, key, existing.projectId, existing.title, "adopted", file, true, {
      note: "Adopted an existing ChatGPT Project for this repository instead of creating a duplicate.",
    });
  }

  const created = await context.surface.createProject({ title, instructions: context.instructions });
  if (created.ok) {
    return persistCreated(context, key, created.projectId, created.title, "created", file, created.instructionsApplied);
  }

  // Someone else created it between the list and the create. Re-list and adopt instead of failing or
  // producing a second Project — this is the concurrent-setup guard.
  if (created.reason === "name-taken" && attempt === 0) {
    return createOrAdopt(context, key, title, file, attempt + 1);
  }
  return { ok: false, reason: createReason(created.reason), explanation: createExplanation(created.reason) };
}

async function persistCreated(
  context: Context,
  key: ChatGptProjectKey,
  projectId: string,
  projectTitle: string,
  event: "created" | "adopted",
  file: ProjectMappingFile,
  instructionsApplied: boolean,
  extra: { readonly note?: string } = {},
): Promise<EnsureProjectResult> {
  const timestamp = context.now().toISOString();
  const mapping: ChatGptProjectMapping = {
    repository: context.repository,
    projectKey: key,
    projectId,
    projectUrl: canonicalProjectUrl(projectId),
    projectTitle,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
    renameCount: 0,
    recreateCount: 0,
    instructionsApplied,
    lastEvent: event,
  };
  const persisted = await persist(context, key, mapping, file);
  if (!persisted.ok) return persisted.refusal;
  return { ok: true, outcome: event, mapping, instructionsApplied, ...extra };
}

async function applyInstructionsIfNeeded(context: Context, mapping: ChatGptProjectMapping): Promise<ChatGptProjectMapping> {
  if (mapping.instructionsApplied) return mapping;
  const applied = await context.surface.applyInstructions(mapping.projectId, context.instructions);
  if (!applied) return mapping;
  return {
    ...mapping,
    instructionsApplied: true,
    lastEvent: "instructions-applied",
    revision: mapping.revision + 1,
    updatedAt: context.now().toISOString(),
  };
}

async function persist(
  context: Context,
  key: ChatGptProjectKey,
  mapping: ChatGptProjectMapping,
  base?: ProjectMappingFile,
): Promise<{ ok: true } | { ok: false; refusal: EnsureProjectResult }> {
  try {
    assertCredentialFreeValue("project mapping", mapping);
  } catch (error) {
    return {
      ok: false,
      refusal: {
        ok: false,
        reason: "state-corrupt",
        explanation: `Refusing to persist a Project mapping that looks like credential material: ${(error as Error).message}`,
      },
    };
  }
  const source = base ?? (await readProjectMappingFile(context.layout, context.fileSystem)).file;
  const next: ProjectMappingFile = {
    version: PROJECT_MAPPING_SCHEMA_VERSION,
    projects: { ...source.projects, [key]: mapping },
  };
  // Persist before the caller is allowed to use the mapping (INV-15); a failed write is a failed
  // provisioning, never a silently in-memory Project.
  await writeJsonFileAtomically(context.layout.projectMappingFile, next, context.fileSystem);
  return { ok: true };
}

function stateReason(error: unknown): ProjectRefusalReason {
  const code = (error as { code?: string }).code;
  return code === "state-busy" ? "state-busy" : "state-unreadable";
}

function stateExplanation(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Adviser state is busy or unreadable, so no Project was created: ${message}`;
}

function createReason(reason: "name-taken" | "needs-human" | "surface-unrecognised" | "provider-error" | "browser-lost"): ProjectRefusalReason {
  if (reason === "name-taken") return "create-failed";
  return reason;
}

function createExplanation(reason: ProjectRefusalReason | "name-taken"): string {
  switch (reason) {
    case "needs-human":
      return "ChatGPT asked for a sign-in or verification before a Project could be created.";
    case "surface-unrecognised":
      return "The ChatGPT Projects surface did not match the expected controls; the adviser UI may have changed.";
    case "provider-error":
    case "name-taken":
      return "ChatGPT refused to create the Project; retry once, then report it if it persists.";
    case "browser-lost":
      return "The adviser browser stopped responding before the Project was created.";
    default:
      return "The Project could not be created.";
  }
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9_-]{4,120}$/u.test(value);
}

function canonicalProjectUrl(projectId: string): string {
  if (!isOpaqueId(projectId)) throw new Error(`Invalid ChatGPT Project id: ${projectId.slice(0, 24)}`);
  return `https://chatgpt.com/p/${encodeURIComponent(projectId)}`;
}

function isCanonicalProjectUrl(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/chatgpt\.com\/p\/[A-Za-z0-9_-]{4,120}$/u.test(value);
}
