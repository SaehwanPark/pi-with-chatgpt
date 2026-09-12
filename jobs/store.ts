/**
 * Durable, same-host job transactions. Claim before submitting; complete before notifying (INV-15).
 * A running job is never made queued again: after a crash, browser submission is ambiguous and must
 * be reconciled explicitly. Locks cover local writes only, never a browser wait.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { repositoryStateLayout, type AdviserStateLayout } from "../config/state-layout.js";
import { assertCredentialFreeValue, UnsafeLedgerRecordError } from "../ledger/record.js";
import {
  acquireStateLock,
  ensurePrivateDirectory,
  nodeStateStore,
  readJsonFile,
  writeJsonFileAtomically,
  type StateStoreFileSystem,
} from "../ledger/state-store.js";
import { isConsultationId, type ConsultationId } from "../protocol/checkpoint.js";
import type { GitHubRepositoryKey } from "../protocol/repo.js";
import { canTransition, isTerminalJobState } from "./state.js";
import {
  createQueuedJob,
  deliveryKeyForSession,
  InvalidJobRecordError,
  parseJobFile,
  transitionJob,
  type CreateJobInput,
  type JobBinding,
  type JobFailureCode,
  type JobRecord,
  type JobResult,
} from "./record.js";

/** Internal routing data, never a worker-facing status projection or an authentication credential. */
export interface JobAddress {
  readonly consultationId: ConsultationId;
  readonly repository: GitHubRepositoryKey;
  readonly taskId: string;
  readonly deliveryKey: string;
}

/** Optional scope used when resolving an ID supplied by a user-facing command. */
export interface JobLookupScope {
  readonly repository?: GitHubRepositoryKey;
  readonly taskId?: string;
  readonly deliveryKey?: string;
  /** Raw Pi session identity; it is hashed before comparison with durable state. */
  readonly sessionId?: string;
}

export interface JobResponse extends JobAddress {
  readonly version: 1;
  readonly resolvedCommit: string;
  readonly text: string;
  readonly result: JobResult;
}

export type CompleteJobInput = Omit<JobResult, "responsePath" | "responseSha256"> & {
  readonly text: string;
};

export type JobStoreFailureCode =
  | "job-invalid"
  | "job-exists"
  | "job-missing"
  | "job-scope-mismatch"
  | "job-transition-invalid"
  | "state-corrupt"
  | "state-unreadable"
  | "state-busy";

/** Codes are safe for caller projection; underlying filesystem errors and paths are not forwarded. */
export class JobStoreError extends Error {
  constructor(readonly code: JobStoreFailureCode) {
    super(`Consultation storage: ${code}.`);
    this.name = "JobStoreError";
  }
}

export function jobAddress(record: JobRecord): JobAddress {
  return {
    consultationId: record.consultationId,
    repository: record.anchor.repository,
    taskId: record.taskId,
    deliveryKey: record.deliveryKey,
  };
}

export function jobFilePath(layout: AdviserStateLayout, id: ConsultationId): string {
  if (!isConsultationId(id) || id.length > 80) throw new JobStoreError("job-invalid");
  return join(layout.jobsDir, `${id}.json`);
}

export class ConsultationJobStore {
  constructor(
    readonly layout: AdviserStateLayout,
    readonly fileSystem: StateStoreFileSystem = nodeStateStore,
  ) {}

  async create(input: CreateJobInput): Promise<JobRecord> {
    let record: JobRecord;
    try {
      record = createQueuedJob(input);
    } catch {
      throw new JobStoreError("job-invalid");
    }
    return this.#transaction(record.consultationId, async () => {
      if (await this.#read(record.consultationId) !== undefined) throw new JobStoreError("job-exists");
      await this.#write(record);
      return record;
    });
  }

  async get(address: JobAddress): Promise<JobRecord | undefined> {
    const expected = structuredClone(address);
    return safeStorageOperation(async () => {
      const record = await this.#read(expected.consultationId);
      if (record !== undefined) assertAddress(record, expected);
      return record;
    });
  }

  /**
   * Resolve a consultation ID to its persisted record. IDs are globally unique, but callers that
   * received an ID from a Pi session can provide a repository/session scope as an additional
   * cross-delivery guard.
   */
  async getByConsultationId(
    consultationId: ConsultationId,
    scope: JobLookupScope = {},
  ): Promise<JobRecord | undefined> {
    const id = consultationId;
    return safeStorageOperation(async () => {
      const record = await this.#read(id);
      if (record !== undefined) assertJobScope(record, scope);
      return record;
    });
  }

  /** Return durable jobs, with optional state filtering, for status and startup reconciliation. */
  async list(options: { readonly states?: readonly JobRecord["state"][] } = {}): Promise<readonly JobRecord[]> {
    return safeStorageOperation(async () => {
      await this.#assertDirectories([this.layout.stateRoot, this.layout.jobsDir]);
      await ensurePrivateDirectory(this.layout.stateRoot, this.fileSystem);
      await ensurePrivateDirectory(this.layout.jobsDir, this.fileSystem);
      const names = await this.fileSystem.readDirectory(this.layout.jobsDir);
      const allowedStates = options.states === undefined ? undefined : new Set(options.states);
      const records: JobRecord[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length) as ConsultationId;
        if (!isConsultationId(id)) throw new JobStoreError("state-corrupt");
        const record = await this.#read(id);
        if (record !== undefined && (allowedStates === undefined || allowedStates.has(record.state))) {
          records.push(record);
        }
      }
      records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return records;
    });
  }

  /**
   * Jobs left in `running` state at process startup have an ambiguous browser outcome. They are
   * never replayed; mark them interrupted so status and the ledger expose the recovery decision.
   */
  async reconcileRunningJobs(): Promise<readonly JobRecord[]> {
    const running = await this.list({ states: ["running"] });
    const reconciled: JobRecord[] = [];
    for (const snapshot of running) {
      const address = jobAddress(snapshot);
      const record = await this.#transaction(snapshot.consultationId, async () => {
        const current = await this.#require(address);
        if (current.state !== "running") return current;
        const interrupted = transitionJob(current, "failed", {
          failure: "interrupted",
          at: this.#timestamp(current),
        });
        await this.#write(interrupted);
        return interrupted;
      });
      reconciled.push(record);
    }
    return reconciled;
  }

  /** Exactly one caller receives claimed:true, including callers in separate Pi processes. */
  async claim(address: JobAddress, binding: JobBinding): Promise<{ claimed: boolean; record: JobRecord }> {
    const expected = structuredClone(address);
    const snapshot = structuredClone(binding);
    return this.#transaction(expected.consultationId, async () => {
      const current = await this.#require(expected);
      if (current.state !== "queued") return { claimed: false, record: current };
      const record = transitionJob(current, "running", { binding: snapshot, at: this.#timestamp(current) });
      await this.#write(record);
      return { claimed: true, record };
    });
  }

  async complete(address: JobAddress, input: CompleteJobInput): Promise<JobRecord> {
    const expected = structuredClone(address);
    const snapshot = structuredClone(input);
    return this.#transaction(expected.consultationId, async () => {
      const current = await this.#require(expected);
      if (isTerminalJobState(current.state)) return current;
      if (!canTransition(current.state, "completed")) throw new JobStoreError("job-transition-invalid");
      const { text, ...metadata } = snapshot;
      const result: JobResult = {
        ...metadata,
        responsePath: `responses/${current.consultationId}.json`,
        responseSha256: createHash("sha256").update(text).digest("hex"),
      };
      const completed = transitionJob(current, "completed", { result, at: this.#timestamp(current) });
      const response: JobResponse = {
        version: 1, ...jobAddress(current), resolvedCommit: current.anchor.resolvedCommit, text, result,
      };
      assertCredentialFreeValue("job response", response);
      // The first response is retained even when a process dies before its terminal record is written.
      // A retry may commit that same response, but may not replace it with a second adviser answer.
      const existing = await this.#readResponse(current);
      if (existing !== undefined && !isDeepStrictEqual(existing, response)) {
        throw new JobStoreError("state-corrupt");
      }
      await this.#prepareResponseDirectories(current);
      if (existing === undefined) {
        await writeJsonFileAtomically(this.#responsePath(current), response, this.fileSystem);
      }
      await this.#write(completed);
      return completed;
    });
  }

  fail(address: JobAddress, failure: JobFailureCode): Promise<JobRecord> {
    return this.#finish(address, "failed", failure);
  }

  cancel(address: JobAddress): Promise<JobRecord> {
    return this.#finish(address, "cancelled");
  }

  /**
   * Also exposes a saved response on a running job after an interrupted completion write. The caller
   * sees the separate job state and must reconcile it; this method never claims completion or wakes Pi.
   */
  async readPersistedResponse(address: JobAddress): Promise<JobResponse | undefined> {
    const expected = structuredClone(address);
    return safeStorageOperation(async () => {
      const current = await this.#require(expected);
      const response = await this.#readResponse(current);
      if (current.state === "completed" && response === undefined) throw new JobStoreError("state-corrupt");
      return response;
    });
  }

  async #finish(address: JobAddress, state: "failed" | "cancelled", failure?: JobFailureCode): Promise<JobRecord> {
    const expected = structuredClone(address);
    return this.#transaction(expected.consultationId, async () => {
      const current = await this.#require(expected);
      if (isTerminalJobState(current.state)) return current;
      if (!canTransition(current.state, state)) throw new JobStoreError("job-transition-invalid");
      const record = transitionJob(current, state, { failure, at: this.#timestamp(current) });
      await this.#write(record);
      return record;
    });
  }

  #timestamp(current: JobRecord): string {
    // A backwards wall clock must not make valid persisted state unreadable.
    return new Date(Math.max(this.fileSystem.now(), Date.parse(current.updatedAt))).toISOString();
  }

  async #read(id: ConsultationId): Promise<JobRecord | undefined> {
    const path = jobFilePath(this.layout, id);
    await this.#assertDirectories([this.layout.stateRoot, this.layout.jobsDir]);
    const read = await readJsonFile(path, parseJobFile, this.fileSystem);
    if (!read.ok) throw new JobStoreError(read.code);
    const record = read.value?.record;
    if (record !== undefined && record.consultationId !== id) throw new JobStoreError("state-corrupt");
    return record;
  }

  async #require(address: JobAddress): Promise<JobRecord> {
    const record = await this.#read(address.consultationId);
    if (record === undefined) throw new JobStoreError("job-missing");
    assertAddress(record, address);
    return record;
  }

  async #write(record: JobRecord): Promise<void> {
    validateRecord(record);
    await writeJsonFileAtomically(jobFilePath(this.layout, record.consultationId), { version: 1, record }, this.fileSystem);
  }

  #responsePath(record: JobRecord): string {
    return join(repositoryStateLayout(this.layout, record.anchor.repository).responsesDir, `${record.consultationId}.json`);
  }

  #responseDirectories(record: JobRecord): readonly string[] {
    const repository = repositoryStateLayout(this.layout, record.anchor.repository);
    return [this.layout.stateRoot, this.layout.repositoriesDir, repository.dir, repository.responsesDir];
  }

  async #prepareResponseDirectories(record: JobRecord): Promise<void> {
    for (const path of this.#responseDirectories(record)) {
      await this.#assertDirectories([path]);
      await ensurePrivateDirectory(path, this.fileSystem);
    }
  }

  async #readResponse(record: JobRecord): Promise<JobResponse | undefined> {
    await this.#assertDirectories(this.#responseDirectories(record));
    const read = await readJsonFile(this.#responsePath(record), (raw) => parseResponse(raw, record), this.fileSystem);
    if (!read.ok) throw new JobStoreError(read.code);
    return read.value;
  }

  async #assertDirectories(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      if (await this.fileSystem.isSymlink(path)) throw new JobStoreError("state-corrupt");
    }
  }

  async #transaction<T>(id: ConsultationId, operation: () => Promise<T>): Promise<T> {
    jobFilePath(this.layout, id);
    return safeStorageOperation(async () => {
      for (const path of [this.layout.stateRoot, this.layout.jobsDir, this.layout.locksDir]) {
        await this.#assertDirectories([path]);
        await ensurePrivateDirectory(path, this.fileSystem);
      }
      const lockPath = join(this.layout.locksDir, `job-${id}.lock`);
      if (await this.fileSystem.isSymlink(lockPath)) throw new JobStoreError("state-corrupt");
      const lock = await acquireStateLock({ path: lockPath, fileSystem: this.fileSystem });
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    });
  }
}

function validateRecord(record: JobRecord): void {
  if (parseJobFile({ version: 1, record }) === undefined) throw new JobStoreError("job-invalid");
}

function assertAddress(record: JobRecord, expected: JobAddress): void {
  const actual = jobAddress(record);
  if (actual.consultationId !== expected.consultationId || actual.repository !== expected.repository ||
      actual.taskId !== expected.taskId || actual.deliveryKey !== expected.deliveryKey) {
    throw new JobStoreError("job-scope-mismatch");
  }
}

function assertJobScope(record: JobRecord, scope: JobLookupScope): void {
  if (scope.repository !== undefined && record.anchor.repository !== scope.repository) {
    throw new JobStoreError("job-scope-mismatch");
  }
  if (scope.taskId !== undefined && record.taskId !== scope.taskId) {
    throw new JobStoreError("job-scope-mismatch");
  }
  if (scope.deliveryKey !== undefined && record.deliveryKey !== scope.deliveryKey) {
    throw new JobStoreError("job-scope-mismatch");
  }
  if (scope.sessionId !== undefined && record.deliveryKey !== deliveryKeyForSession(scope.sessionId)) {
    throw new JobStoreError("job-scope-mismatch");
  }
}

function parseResponse(raw: unknown, record: JobRecord): JobResponse | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Partial<JobResponse>;
  const fields = ["version", "consultationId", "repository", "taskId", "deliveryKey", "resolvedCommit", "text", "result"];
  if (Object.keys(raw).length !== fields.length || Object.keys(raw).some((key) => !fields.includes(key))) return undefined;
  if (value.version !== 1 || typeof value.text !== "string" || value.result === undefined ||
      value.resolvedCommit !== record.anchor.resolvedCommit) return undefined;
  try {
    assertAddress(record, value as JobResponse);
    assertCredentialFreeValue("job response", value);
    // Reuse the complete job schema for result shape and its deterministic path constraints.
    const resultRecord = {
      ...record, state: "completed", result: value.result,
      revision: Math.max(3, record.revision),
      finishedAt: record.finishedAt ?? record.updatedAt,
    };
    const { failure: _failure, ...withoutFailure } = resultRecord;
    if (parseJobFile({ version: 1, record: withoutFailure }) === undefined) return undefined;
    if (value.result.responseSha256 !== createHash("sha256").update(value.text).digest("hex")) return undefined;
    if (record.result !== undefined && !isDeepStrictEqual(record.result, value.result)) return undefined;
    return value as JobResponse;
  } catch {
    return undefined;
  }
}

async function safeStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof JobStoreError) throw error;
    if (error instanceof InvalidJobRecordError || error instanceof UnsafeLedgerRecordError) {
      throw new JobStoreError("job-invalid");
    }
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    throw new JobStoreError(code === "state-busy" ? "state-busy" : "state-unreadable");
  }
}
