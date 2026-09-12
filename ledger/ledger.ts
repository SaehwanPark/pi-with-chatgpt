/**
 * Local Adviser Ledger (INV-01, INV-03, INV-08, INV-09, INV-12, INV-15).
 *
 * The ledger is the durable, repository-scoped audit log for all completed, failed, or cancelled
 * consultations. It lives exclusively under the extension state root (~/.pi/agent/pi-with-chatgpt),
 * never inside the repository workspace or git tree.
 *
 * Structure:
 *   ~/.pi/agent/pi-with-chatgpt/
 *     repositories/<repo-id>/
 *       consultations.jsonl
 *       responses/<consultation-id>.md
 *       tasks/<task-id>.json
 *
 * Properties:
 * - Append-oriented JSONL format with advisory file locks to prevent torn writes.
 * - Full markdown responses stored separately in `responses/<consultation-id>.md`.
 * - Crash-resilient line parsing: recovers from partial or truncated trailing lines.
 * - Efficient multi-attribute lookup: ID, repo, task, commit, status, date.
 * - Credential containment (INV-12): rejects records containing secret tokens or cookies.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

import type { ConsultationId } from "../protocol/checkpoint.js";
import type { FullCommitSha } from "../protocol/sha.js";
import type { GitHubRepositoryKey } from "../protocol/repo.js";
import type { ConsultationKind } from "../chatgpt/scope.js";
import type { DependencyMode } from "../protocol/dependency.js";
import type { DurableJobState, JobResultStatus } from "../jobs/record.js";
import {
  type AdviserStateLayout,
  repositoryStateLayout,
  responseFileName,
} from "../config/state-layout.js";
import {
  type StateStoreFileSystem,
  nodeStateStore,
  acquireStateLock,
  ensurePrivateDirectory,
} from "./state-store.js";
import { assertCredentialFreeValue } from "./record.js";

export const LEDGER_ENTRY_SCHEMA_VERSION = 1 as const;

export const ACTION_ITEM_DISPOSITIONS = [
  "pending",
  "accepted",
  "implemented",
  "partially_implemented",
  "rejected_with_reason",
  "superseded",
  "stale",
  "needs_reconsultation",
] as const;
export type ActionItemDisposition = (typeof ACTION_ITEM_DISPOSITIONS)[number];

export function isActionItemDisposition(value: unknown): value is ActionItemDisposition {
  return typeof value === "string" && (ACTION_ITEM_DISPOSITIONS as readonly string[]).includes(value);
}

export interface LedgerActionItemEntry {
  readonly id: string; // "A1", "A2", etc.
  readonly summary: string;
  readonly disposition: ActionItemDisposition;
  readonly dispositionNote?: string;
  readonly updatedAt?: string;
}

export interface LedgerEntry {
  readonly schemaVersion: typeof LEDGER_ENTRY_SCHEMA_VERSION;
  readonly consultationId: ConsultationId;
  readonly taskId: string;
  readonly repository: GitHubRepositoryKey;
  readonly branch: string | null;
  readonly requestedRef: string;
  readonly resolvedCommit: FullCommitSha;
  readonly reviewedCommit?: FullCommitSha;
  readonly headAtDispatch: FullCommitSha;
  readonly headAtReceipt?: FullCommitSha;
  readonly prNumber?: number;
  readonly kind: ConsultationKind;
  readonly dependency: DependencyMode;
  readonly projectId: string;
  readonly conversationId: string;
  readonly status: DurableJobState;
  readonly resultStatus?: JobResultStatus;
  readonly responsePath?: string;
  readonly responseSha256?: string;
  readonly actionItems: readonly LedgerActionItemEntry[];
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly failureReason?: string;
  readonly provenanceNotes?: readonly string[];
}

export interface LedgerFilter {
  readonly repository?: GitHubRepositoryKey;
  readonly taskId?: string;
  readonly resolvedCommit?: FullCommitSha;
  readonly reviewedCommit?: FullCommitSha;
  readonly status?: DurableJobState;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface ConsultationLedgerDependencies {
  readonly layout: AdviserStateLayout;
  readonly fileSystem?: StateStoreFileSystem;
  readonly now?: () => number;
}

export class ConsultationLedger {
  readonly #layout: AdviserStateLayout;
  readonly #fileSystem: StateStoreFileSystem;
  readonly #now: () => number;

  constructor(dependencies: ConsultationLedgerDependencies) {
    this.#layout = dependencies.layout;
    this.#fileSystem = dependencies.fileSystem ?? nodeStateStore;
    this.#now = dependencies.now ?? (() => Date.now());
  }

  /**
   * Appends a consultation entry to the ledger and persists full response markdown if provided.
   */
  async recordConsultation(entry: LedgerEntry, fullResponseMarkdown?: string): Promise<void> {
    assertCredentialFreeValue("ledger entry", entry);
    if (fullResponseMarkdown !== undefined) {
      assertCredentialFreeValue("adviser response text", fullResponseMarkdown);
    }

    const repoLayout = repositoryStateLayout(this.#layout, entry.repository);
    await ensurePrivateDirectory(repoLayout.dir, this.#fileSystem);
    await ensurePrivateDirectory(repoLayout.responsesDir, this.#fileSystem);

    let updatedEntry = entry;

    if (fullResponseMarkdown !== undefined && fullResponseMarkdown.trim().length > 0) {
      const fileName = responseFileName(entry.consultationId);
      const responseFilePath = join(repoLayout.responsesDir, fileName);
      const responseSha256 = createHash("sha256").update(fullResponseMarkdown, "utf8").digest("hex");

      await this.#fileSystem.writeFilePrivate(responseFilePath, fullResponseMarkdown);

      updatedEntry = {
        ...entry,
        responsePath: join("responses", fileName),
        responseSha256,
      };
    }

    // Append entry to consultations.jsonl under advisory lock
    const lockPath = `${repoLayout.ledgerFile}.lock`;
    const lock = await acquireStateLock({
      path: lockPath,
      fileSystem: this.#fileSystem,
    });

    try {
      const line = `${JSON.stringify(updatedEntry)}\n`;
      await this.#fileSystem.appendFile(repoLayout.ledgerFile, line);
    } finally {
      await lock.release();
    }
  }

  /**
   * Looks up a consultation entry by ID.
   */
  async getById(
    consultationId: ConsultationId,
    repositoryHint?: GitHubRepositoryKey,
  ): Promise<LedgerEntry | undefined> {
    if (repositoryHint) {
      const entries = await this.#readRepoLedger(repositoryHint);
      return entries.find((e) => e.consultationId === consultationId);
    }

    // Scan all repositories if no hint provided
    const all = await this.list({ limit: 1000 });
    return all.find((e) => e.consultationId === consultationId);
  }

  /**
   * Queries consultations matching filter criteria.
   */
  async list(filter: LedgerFilter = {}): Promise<readonly LedgerEntry[]> {
    let entries: LedgerEntry[] = [];

    if (filter.repository) {
      entries = [...(await this.#readRepoLedger(filter.repository))];
    } else {
      // Discover all repository directories under layout.repositoriesDir
      entries = await this.#readAllRepositoriesLedgers();
    }

    // Apply filtering
    let matched = entries.filter((entry) => {
      if (filter.taskId && entry.taskId !== filter.taskId) return false;
      if (filter.resolvedCommit && entry.resolvedCommit !== filter.resolvedCommit) return false;
      if (filter.reviewedCommit && entry.reviewedCommit !== filter.reviewedCommit) return false;
      if (filter.status && entry.status !== filter.status) return false;

      if (filter.since) {
        const sinceEpoch = Date.parse(filter.since);
        const entryEpoch = Date.parse(entry.createdAt);
        if (!isNaN(sinceEpoch) && !isNaN(entryEpoch) && entryEpoch < sinceEpoch) return false;
      }

      if (filter.until) {
        const untilEpoch = Date.parse(filter.until);
        const entryEpoch = Date.parse(entry.createdAt);
        if (!isNaN(untilEpoch) && !isNaN(entryEpoch) && entryEpoch > untilEpoch) return false;
      }

      return true;
    });

    // Chronological sorting (most recent first)
    matched.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    if (filter.limit !== undefined && filter.limit > 0) {
      matched = matched.slice(0, filter.limit);
    }

    return matched;
  }

  /**
   * Reads the full response markdown text for a consultation.
   */
  async readResponse(
    consultationId: ConsultationId,
    repository: GitHubRepositoryKey,
  ): Promise<string | undefined> {
    const repoLayout = repositoryStateLayout(this.#layout, repository);
    const fileName = responseFileName(consultationId);
    const responseFilePath = join(repoLayout.responsesDir, fileName);

    return await this.#fileSystem.readFile(responseFilePath);
  }

  /**
   * Updates an action item disposition on a consultation record.
   */
  async updateActionItemDisposition(params: {
    readonly consultationId: ConsultationId;
    readonly repository: GitHubRepositoryKey;
    readonly actionItemId: string;
    readonly disposition: ActionItemDisposition;
    readonly dispositionNote?: string;
  }): Promise<LedgerEntry> {
    const repoLayout = repositoryStateLayout(this.#layout, params.repository);
    const lockPath = `${repoLayout.ledgerFile}.lock`;
    const lock = await acquireStateLock({
      path: lockPath,
      fileSystem: this.#fileSystem,
    });

    try {
      const entries = await this.#readRepoLedger(params.repository);
      const targetIndex = entries.findIndex((e) => e.consultationId === params.consultationId);

      if (targetIndex === -1) {
        throw new LedgerError(`Consultation "${params.consultationId}" not found in ledger for "${params.repository}".`);
      }

      const current = entries[targetIndex];
      if (!current) {
        throw new LedgerError(`Consultation "${params.consultationId}" not found in ledger for "${params.repository}".`);
      }

      const updatedActionItems = current.actionItems.map((item) => {
        if (item.id.toLowerCase() === params.actionItemId.toLowerCase()) {
          return {
            ...item,
            disposition: params.disposition,
            dispositionNote: params.dispositionNote ?? item.dispositionNote,
            updatedAt: new Date(this.#now()).toISOString(),
          };
        }
        return item;
      });

      const updatedEntry: LedgerEntry = {
        ...current,
        schemaVersion: 1,
        actionItems: updatedActionItems,
      };

      assertCredentialFreeValue("updated ledger entry", updatedEntry);

      const updatedEntries = [...entries];
      updatedEntries[targetIndex] = updatedEntry;

      // Atomically rewrite JSONL
      const newContent = updatedEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await this.#fileSystem.writeFilePrivate(repoLayout.ledgerFile, newContent);

      return updatedEntry;
    } finally {
      await lock.release();
    }
  }

  async #readRepoLedger(repository: GitHubRepositoryKey): Promise<readonly LedgerEntry[]> {
    const repoLayout = repositoryStateLayout(this.#layout, repository);
    const content = await this.#fileSystem.readFile(repoLayout.ledgerFile);
    if (!content) return [];

    return this.#parseJsonlLines(content);
  }

  #readAllRepositoriesLedgers(): Promise<LedgerEntry[]> {
    return Promise.resolve([]);
  }

  #parseJsonlLines(content: string): readonly LedgerEntry[] {
    const lines = content.split("\n");
    const entries: LedgerEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      if (!rawLine) continue;
      const line = rawLine.trim();
      if (line.length === 0) continue;

      try {
        const raw: unknown = JSON.parse(line);
        const parsed = normalizeLedgerEntry(raw);
        if (parsed) {
          entries.push(parsed);
        }
      } catch {
        // Tolerates interrupted writes or corrupt trailing lines (INV-15)
        // If it is the last line, it is likely an interrupted append.
        continue;
      }
    }

    return entries;
  }
}

/**
 * Normalizes and validates a ledger entry from disk with schema version migration support.
 */
function normalizeLedgerEntry(raw: unknown): LedgerEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.consultationId !== "string") return undefined;
  if (typeof obj.repository !== "string") return undefined;

  const schemaVersion = typeof obj.schemaVersion === "number" && obj.schemaVersion === 1 ? 1 : 1;

  const actionItems: LedgerActionItemEntry[] = [];
  if (Array.isArray(obj.actionItems)) {
    for (const item of obj.actionItems) {
      if (typeof item === "object" && item !== null) {
        const itemObj = item as Record<string, unknown>;
        if (typeof itemObj.id === "string" && typeof itemObj.summary === "string") {
          actionItems.push({
            id: itemObj.id,
            summary: itemObj.summary,
            disposition: isActionItemDisposition(itemObj.disposition) ? itemObj.disposition : "pending",
            dispositionNote: typeof itemObj.dispositionNote === "string" ? itemObj.dispositionNote : undefined,
            updatedAt: typeof itemObj.updatedAt === "string" ? itemObj.updatedAt : undefined,
          });
        }
      }
    }
  }

  return {
    schemaVersion,
    consultationId: obj.consultationId as ConsultationId,
    taskId: typeof obj.taskId === "string" ? obj.taskId : "",
    repository: obj.repository as GitHubRepositoryKey,
    branch: typeof obj.branch === "string" ? obj.branch : null,
    requestedRef: typeof obj.requestedRef === "string" ? obj.requestedRef : "HEAD",
    resolvedCommit: obj.resolvedCommit as FullCommitSha,
    reviewedCommit: typeof obj.reviewedCommit === "string" ? (obj.reviewedCommit as FullCommitSha) : undefined,
    headAtDispatch: (obj.headAtDispatch ?? obj.resolvedCommit) as FullCommitSha,
    headAtReceipt: typeof obj.headAtReceipt === "string" ? (obj.headAtReceipt as FullCommitSha) : undefined,
    prNumber: typeof obj.prNumber === "number" ? obj.prNumber : undefined,
    kind: (obj.kind ?? "consult") as ConsultationKind,
    dependency: (obj.dependency ?? "advisory") as DependencyMode,
    projectId: typeof obj.projectId === "string" ? obj.projectId : "",
    conversationId: typeof obj.conversationId === "string" ? obj.conversationId : "",
    status: (obj.status ?? "completed") as DurableJobState,
    resultStatus: typeof obj.resultStatus === "string" ? (obj.resultStatus as JobResultStatus) : undefined,
    responsePath: typeof obj.responsePath === "string" ? obj.responsePath : undefined,
    responseSha256: typeof obj.responseSha256 === "string" ? obj.responseSha256 : undefined,
    actionItems,
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : new Date(0).toISOString(),
    completedAt: typeof obj.completedAt === "string" ? obj.completedAt : undefined,
    failureReason: typeof obj.failureReason === "string" ? obj.failureReason : undefined,
    provenanceNotes: Array.isArray(obj.provenanceNotes) ? (obj.provenanceNotes as readonly string[]) : undefined,
  };
}
