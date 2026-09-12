/**
 * Versioned, credential-free consultation job records (M5).
 *
 * A job is deliberately a small state envelope.  The anchor and delivery address are the
 * immutable identity; the rest of the fields describe the durable progress of the adviser call.
 * Browser/session state and raw Pi session identifiers do not belong here.
 */

import { createHash, randomUUID } from "node:crypto";

import { assertCredentialFreeValue } from "../ledger/record.js";
import { isConsultationKind, type ConsultationKind } from "../chatgpt/scope.js";
import { isConsultationId, type ConsultationAnchor, type ConsultationId } from "../protocol/checkpoint.js";
import { DEFAULT_DEPENDENCY_MODE, type DependencyMode } from "../protocol/dependency.js";
import { parseGitHubRemote, type GitHubRepositoryKey } from "../protocol/repo.js";
import { isFullCommitSha, type FullCommitSha } from "../protocol/sha.js";
import { canTransition as stateCanTransition, type JobState } from "./state.js";

export const JOB_FILE_SCHEMA_VERSION = 1 as const;

/** States persisted by the durable M5 store.  Other UI/runtime states are not file states. */
export type DurableJobState = Extract<JobState, "queued" | "running" | "completed" | "failed" | "cancelled">;

export const DURABLE_JOB_STATES = ["queued", "running", "completed", "failed", "cancelled"] as const;

export type JobMode = "sync" | "async";

/** Provider/runtime failures are an intentionally closed vocabulary (never arbitrary exception text). */
export const JOB_FAILURE_CODES = [
  "auth_expired",
  "challenge",
  "quota",
  "capability",
  "connector",
  "repo_access",
  "not_remote",
  "project",
  "browser",
  "timeout",
  "account",
  "cancelled",
  "interrupted",
] as const;
export type JobFailureCode = (typeof JOB_FAILURE_CODES)[number];

import { JOB_RESULT_STATUSES, type JobResultStatus } from "../protocol/response.js";
export { JOB_RESULT_STATUSES, type JobResultStatus };

/** Stable slots for M6 action-item parsing.  M5 stores, but does not interpret, adviser prose. */
export interface JobActionItem {
  readonly id: string;
  readonly summary: string;
}

export interface JobBinding {
  readonly projectId: string;
  readonly conversationId: string;
  readonly headAtDispatch: FullCommitSha;
}

export interface JobResult {
  readonly headAtReceipt?: FullCommitSha;
  readonly responsePath: string;
  readonly responseSha256: string;
  readonly resultStatus: JobResultStatus;
  readonly actionItems: readonly JobActionItem[];
}

/**
 * The persisted job record.  Identity fields are never changed by a transition; a transition
 * returns a new object and increases `revision`.
 */
export interface JobRecord {
  readonly consultationId: ConsultationId;
  readonly anchor: ConsultationAnchor;
  /** Branch at dispatch time; `null` represents a detached HEAD. This is advisory metadata. */
  readonly branch: string | null;
  readonly taskId: string;
  /** SHA-256 of the originating Pi session id; the raw session id is never persisted. */
  readonly deliveryKey: string;
  readonly kind: ConsultationKind;
  readonly dependency: DependencyMode;
  readonly mode: JobMode;
  readonly state: DurableJobState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly binding?: JobBinding;
  readonly result?: JobResult;
  readonly failure?: JobFailureCode;
}

export interface JobFile {
  readonly version: typeof JOB_FILE_SCHEMA_VERSION;
  readonly record: JobRecord;
}

/** Input accepted by `createQueuedJob`; only the digest, never `sessionId`, reaches the record. */
export interface CreateJobInput {
  readonly anchor: ConsultationAnchor;
  readonly branch: string | null;
  readonly taskId: string;
  readonly kind: ConsultationKind;
  readonly sessionId?: string;
  /** Advanced callers may supply an already-derived digest (for example after a process handoff). */
  readonly deliveryKey?: string;
  readonly consultationId?: ConsultationId;
  readonly dependency?: DependencyMode;
  readonly mode?: JobMode;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export type JobTransitionTarget = Exclude<DurableJobState, "queued">;

export interface JobTransitionOptions {
  readonly at?: string;
  readonly binding?: JobBinding;
  readonly result?: JobResult;
  readonly failure?: JobFailureCode;
}

export class InvalidJobRecordError extends Error {
  constructor() {
    super("Invalid consultation job record.");
    this.name = "InvalidJobRecordError";
  }
}

export class IllegalJobRecordTransitionError extends Error {
  constructor() {
    super("Illegal consultation job transition.");
    this.name = "IllegalJobRecordTransitionError";
  }
}

/** Return the deterministic relative location used by the response envelope. */
export function responsePathForConsultation(consultationId: ConsultationId): string {
  if (!isConsultationIdValue(consultationId)) throw new InvalidJobRecordError();
  return `responses/${consultationId}.json`;
}

/** Derive a routing digest without ever placing the session identifier in durable state. */
export function deliveryKeyForSession(sessionId: string): string {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) throw new InvalidJobRecordError();
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

/** Allocate a stable adviser id before browser dispatch. */
export function generateConsultationId(): ConsultationId {
  return `adv-${randomUUID()}` as ConsultationId;
}

/** Create the only valid initial durable state: queued, revision 1, and without a binding/result. */
export function createQueuedJob(input: CreateJobInput): JobRecord {
  const deliveryKey = deriveDeliveryKey(input);
  const consultationId = input.consultationId ?? generateConsultationId();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? createdAt;
  const candidate: JobRecord = {
    consultationId,
    anchor: cloneAnchor(input.anchor),
    branch: input.branch,
    taskId: input.taskId,
    deliveryKey,
    kind: input.kind,
    dependency: input.dependency ?? DEFAULT_DEPENDENCY_MODE,
    mode: input.mode ?? "async",
    state: "queued",
    revision: 1,
    createdAt,
    updatedAt,
  };
  assertJobRecord(candidate);
  return deepFreeze(candidate);
}

/**
 * Validate a candidate record.  No caller-controlled text is included in the thrown error: state
 * records are often read while handling an unrelated provider failure.
 */
export function assertJobRecord(value: unknown): asserts value is JobRecord {
  if (!isRecord(value) || !hasKeys(value, JOB_RECORD_KEYS, REQUIRED_RECORD_KEYS)) throw new InvalidJobRecordError();

  if (!isConsultationIdValue(value.consultationId)) throw new InvalidJobRecordError();
  if (!isRecord(value.anchor) || parseAnchor(value.anchor) === undefined) throw new InvalidJobRecordError();
  if (value.branch !== null && !isSafeText(value.branch)) throw new InvalidJobRecordError();
  if (!isSafeText(value.taskId) || !isSha256(value.deliveryKey)) throw new InvalidJobRecordError();
  if (!isConsultationKindValue(value.kind) || !isDependencyMode(value.dependency) || !isJobMode(value.mode)) {
    throw new InvalidJobRecordError();
  }
  if (!isDurableState(value.state)) throw new InvalidJobRecordError();
  if (!isRevision(value.revision) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    throw new InvalidJobRecordError();
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new InvalidJobRecordError();

  if (value.startedAt !== undefined && !isTimestamp(value.startedAt)) throw new InvalidJobRecordError();
  if (value.finishedAt !== undefined && !isTimestamp(value.finishedAt)) throw new InvalidJobRecordError();
  if (value.startedAt !== undefined && Date.parse(value.startedAt) < Date.parse(value.createdAt)) {
    throw new InvalidJobRecordError();
  }
  if (value.finishedAt !== undefined) {
    const floor = value.startedAt ?? value.createdAt;
    if (Date.parse(value.finishedAt) < Date.parse(floor)) throw new InvalidJobRecordError();
  }

  if (value.binding !== undefined && parseBinding(value.binding) === undefined) throw new InvalidJobRecordError();
  if ((value.startedAt === undefined) !== (value.binding === undefined)) throw new InvalidJobRecordError();
  if (value.result !== undefined && parseResult(value.result, value.consultationId) === undefined) {
    throw new InvalidJobRecordError();
  }
  if (value.failure !== undefined && !isFailureCode(value.failure)) throw new InvalidJobRecordError();
  assertStateShape(value);
  try {
    assertCredentialFreeValue("job record", value);
  } catch {
    throw new InvalidJobRecordError();
  }
}

/** Parse a versioned job file; malformed/corrupt input is represented by `undefined`. */
export function parseJobFile(raw: unknown): JobFile | undefined {
  if (!isRecord(raw) || !hasExactlyKeys(raw, ["version", "record"])) return undefined;
  if (raw.version !== JOB_FILE_SCHEMA_VERSION || !isRecord(raw.record)) return undefined;
  try {
    assertJobRecord(raw.record);
  } catch {
    return undefined;
  }
  return deepFreeze({ version: JOB_FILE_SCHEMA_VERSION, record: structuredClone(raw.record) });
}

/** Parse just a record for callers that already handled the version envelope. */
export function parseJobRecord(raw: unknown): JobRecord | undefined {
  try {
    assertJobRecord(raw);
  } catch {
    return undefined;
  }
  return deepFreeze(structuredClone(raw));
}

/** Whether the requested durable target is one of the M5 transitions. */
export function canTransitionJob(from: DurableJobState, to: JobTransitionTarget): boolean {
  if (!isDurableState(from) || !isDurableState(to)) return false;
  if (from === "completed" || from === "failed" || from === "cancelled") return false;
  return stateCanTransition(from, to);
}

/**
 * Pure transition helper.  Terminal records are returned unchanged for late callbacks, which gives
 * the store a simple first-terminal-winner rule.  All other transitions return a newly validated
 * record, preserving the immutable identity and incrementing revision.
 */
export function transitionJob(
  record: JobRecord,
  to: JobTransitionTarget,
  options: JobTransitionOptions = {},
): JobRecord {
  assertJobRecord(record);
  if (isTerminal(record.state)) return record;
  if (!canTransitionJob(record.state, to)) throw new IllegalJobRecordTransitionError();

  const at = options.at ?? new Date().toISOString();
  if (!isTimestamp(at) || Date.parse(at) < Date.parse(record.updatedAt)) throw new InvalidJobRecordError();
  if (Date.parse(at) < Date.parse(record.updatedAt)) throw new InvalidJobRecordError();
  let next: JobRecord;
  if (to === "running") {
    if (options.binding === undefined) throw new InvalidJobRecordError();
    next = {
      ...record,
      state: "running",
      revision: record.revision + 1,
      updatedAt: at,
      startedAt: at,
      binding: cloneBinding(options.binding),
    };
  } else if (to === "completed") {
    if (options.result === undefined || record.binding === undefined || record.startedAt === undefined) {
      throw new InvalidJobRecordError();
    }
    next = {
      ...record,
      state: "completed",
      revision: record.revision + 1,
      updatedAt: at,
      finishedAt: at,
      result: cloneResult(options.result, record.consultationId),
    };
  } else if (to === "failed") {
    if (options.failure === undefined) throw new InvalidJobRecordError();
    next = {
      ...record,
      state: "failed",
      revision: record.revision + 1,
      updatedAt: at,
      finishedAt: at,
      failure: options.failure,
    };
  } else {
    next = {
      ...record,
      state: "cancelled",
      revision: record.revision + 1,
      updatedAt: at,
      finishedAt: at,
    };
  }
  assertJobRecord(next);
  return deepFreeze(next);
}

const JOB_RECORD_KEYS = [
  "consultationId",
  "anchor",
  "branch",
  "taskId",
  "deliveryKey",
  "kind",
  "dependency",
  "mode",
  "state",
  "revision",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "binding",
  "result",
  "failure",
] as const;

const REQUIRED_RECORD_KEYS = [
  "consultationId",
  "anchor",
  "branch",
  "taskId",
  "deliveryKey",
  "kind",
  "dependency",
  "mode",
  "state",
  "revision",
  "createdAt",
  "updatedAt",
] as const;

const ANCHOR_KEYS = ["repository", "remoteUrl", "requestedRef", "resolvedCommit", "pullRequest", "remoteAvailability"] as const;
const BINDING_KEYS = ["projectId", "conversationId", "headAtDispatch"] as const;
const RESULT_KEYS = ["headAtReceipt", "responsePath", "responseSha256", "resultStatus", "actionItems"] as const;
const ACTION_ITEM_KEYS = ["id", "summary"] as const;

function deriveDeliveryKey(input: CreateJobInput): string {
  if (input.sessionId !== undefined && input.deliveryKey !== undefined) {
    const derived = deliveryKeyForSession(input.sessionId);
    if (derived !== input.deliveryKey) throw new InvalidJobRecordError();
    return derived;
  }
  if (input.sessionId !== undefined) return deliveryKeyForSession(input.sessionId);
  if (input.deliveryKey !== undefined && isSha256(input.deliveryKey)) return input.deliveryKey;
  throw new InvalidJobRecordError();
}

function cloneAnchor(anchor: ConsultationAnchor): ConsultationAnchor {
  if (!isRecord(anchor)) throw new InvalidJobRecordError();
  const parsed = parseAnchor(anchor);
  if (parsed === undefined) throw new InvalidJobRecordError();
  return deepFreeze(structuredClone(parsed));
}

function cloneBinding(binding: JobBinding): JobBinding {
  const parsed = parseBinding(binding);
  if (parsed === undefined) throw new InvalidJobRecordError();
  return deepFreeze(structuredClone(parsed));
}

function cloneResult(result: JobResult, consultationId: ConsultationId): JobResult {
  if (!isRecord(result)) throw new InvalidJobRecordError();
  const parsed = parseResult(result, consultationId);
  if (parsed === undefined) throw new InvalidJobRecordError();
  return deepFreeze(structuredClone(parsed));
}

function parseAnchor(value: Record<string, unknown>): ConsultationAnchor | undefined {
  if (!hasKeys(value, ANCHOR_KEYS, ["repository", "remoteUrl", "requestedRef", "resolvedCommit", "remoteAvailability"])) {
    return undefined;
  }
  if (!isCanonicalRepository(value.repository) || !isSafeText(value.remoteUrl) || !isSafeText(value.requestedRef)) return undefined;
  if (!isExactFullSha(value.resolvedCommit)) return undefined;
  const remote = parseGitHubRemote(value.remoteUrl);
  if (!remote.ok || remote.key === undefined || remote.key !== value.repository || !isRepositoryRemotePath(value.remoteUrl)) return undefined;
  if (!parseAvailableRemote(value.remoteAvailability)) return undefined;
  const pullRequest = value.pullRequest === undefined ? undefined : parsePullRequest(value.pullRequest);
  if (value.pullRequest !== undefined && pullRequest === undefined) return undefined;
  return {
    repository: value.repository,
    remoteUrl: value.remoteUrl,
    requestedRef: value.requestedRef,
    resolvedCommit: value.resolvedCommit as FullCommitSha,
    ...(pullRequest === undefined ? {} : { pullRequest }),
    remoteAvailability: { status: "available" },
  };
}

function parsePullRequest(value: unknown): ConsultationAnchor["pullRequest"] | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, ["number", "headCommit"])) return undefined;
  if (!Number.isInteger(value.number) || (value.number as number) < 1 || !isExactFullSha(value.headCommit)) return undefined;
  return { number: value.number as number, headCommit: value.headCommit as FullCommitSha };
}

function parseAvailableRemote(value: unknown): value is { readonly status: "available" } {
  return isRecord(value) && hasExactlyKeys(value, ["status"]) && value.status === "available";
}

function parseBinding(value: unknown): JobBinding | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, BINDING_KEYS)) return undefined;
  if (!isOpaqueId(value.projectId) || !isOpaqueId(value.conversationId) || !isExactFullSha(value.headAtDispatch)) return undefined;
  return {
    projectId: value.projectId,
    conversationId: value.conversationId,
    headAtDispatch: value.headAtDispatch as FullCommitSha,
  };
}

function parseResult(value: unknown, consultationId: string): JobResult | undefined {
  if (!isRecord(value) || !hasKeys(value, RESULT_KEYS, ["responsePath", "responseSha256", "resultStatus", "actionItems"])) {
    return undefined;
  }
  if (value.headAtReceipt !== undefined && !isExactFullSha(value.headAtReceipt)) return undefined;
  if (!isSafeText(value.responsePath) || value.responsePath !== responsePathForConsultation(consultationId as ConsultationId)) return undefined;
  if (!isSha256(value.responseSha256) || !isResultStatus(value.resultStatus)) return undefined;
  if (!Array.isArray(value.actionItems)) return undefined;
  const actionItems: JobActionItem[] = [];
  const seen = new Set<string>();
  for (const entry of value.actionItems) {
    const parsed = parseActionItem(entry);
    if (parsed === undefined || seen.has(parsed.id)) return undefined;
    seen.add(parsed.id);
    actionItems.push(parsed);
  }
  return {
    ...(value.headAtReceipt === undefined ? {} : { headAtReceipt: value.headAtReceipt as FullCommitSha }),
    responsePath: value.responsePath,
    responseSha256: value.responseSha256,
    resultStatus: value.resultStatus,
    actionItems,
  };
}

function parseActionItem(value: unknown): JobActionItem | undefined {
  if (!isRecord(value) || !hasKeys(value, ACTION_ITEM_KEYS, ["id", "summary"])) return undefined;
  if (!isActionItemId(value.id) || !isSafeText(value.summary)) return undefined;
  return { id: value.id, summary: value.summary };
}

function assertStateShape(value: Record<string, unknown>): void {
  const state = value.state as DurableJobState;
  const revision = value.revision as number;
  if (state === "queued") {
    if (revision !== 1 || value.startedAt !== undefined || value.finishedAt !== undefined || value.binding !== undefined || value.result !== undefined || value.failure !== undefined) {
      throw new InvalidJobRecordError();
    }
    return;
  }
  if (state === "running") {
    if (revision < 2 || value.startedAt === undefined || value.binding === undefined || value.finishedAt !== undefined || value.result !== undefined || value.failure !== undefined) {
      throw new InvalidJobRecordError();
    }
    if (Date.parse(value.startedAt as string) > Date.parse(value.updatedAt as string)) throw new InvalidJobRecordError();
    return;
  }
  if (state === "completed") {
    if (revision < 3 || value.startedAt === undefined || value.finishedAt === undefined || value.binding === undefined || value.result === undefined || value.failure !== undefined) {
      throw new InvalidJobRecordError();
    }
    if (value.finishedAt !== value.updatedAt) throw new InvalidJobRecordError();
    return;
  }
  if (value.finishedAt === undefined || value.result !== undefined) {
    throw new InvalidJobRecordError();
  }
  if (state === "failed" && !isFailureCode(value.failure)) throw new InvalidJobRecordError();
  if (state === "cancelled" && value.failure !== undefined) throw new InvalidJobRecordError();
  if (revision < 2) throw new InvalidJobRecordError();
  if (value.finishedAt !== value.updatedAt) throw new InvalidJobRecordError();
}

function isTerminal(state: DurableJobState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function hasKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isSafeText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{4,120}$/u.test(value);
}

function isCanonicalRepository(value: unknown): value is GitHubRepositoryKey {
  if (typeof value !== "string" || !/^[a-z0-9-]+\/[a-z0-9._-]+$/u.test(value)) return false;
  const [owner, repository] = value.split("/");
  return owner !== "." && owner !== ".." && repository !== "." && repository !== "..";
}

/** `parseGitHubRemote` canonicalises the first two path segments; records must not retain a URL for a subpath. */
function isRepositoryRemotePath(value: string): boolean {
  const trimmed = value.trim().replace(/\/+$/u, "");
  const scp = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
    ? undefined
    : /^(?:[^@/]+@)?[^/:]+:(.+)$/u.exec(trimmed);
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/iu.exec(trimmed);
  const path = scp?.[1] ?? scheme?.[1];
  if (path === undefined) return false;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return false;
  const repository = segments[1]?.replace(/\.git$/u, "");
  return repository !== undefined && repository.length > 0;
}

function isExactFullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value) && isFullCommitSha(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 20 || !value.endsWith("Z")) return false;
  return Number.isFinite(Date.parse(value));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isConsultationIdValue(value: unknown): value is ConsultationId {
  return typeof value === "string" && value.length <= 80 && isConsultationId(value);
}

function isConsultationKindValue(value: unknown): value is ConsultationKind {
  return typeof value === "string" && isConsultationKind(value);
}

function isDependencyMode(value: unknown): value is DependencyMode {
  return value === "advisory" || value === "required";
}

function isJobMode(value: unknown): value is JobMode {
  return value === "sync" || value === "async";
}

function isDurableState(value: unknown): value is DurableJobState {
  return typeof value === "string" && (DURABLE_JOB_STATES as readonly string[]).includes(value);
}

function isFailureCode(value: unknown): value is JobFailureCode {
  return typeof value === "string" && (JOB_FAILURE_CODES as readonly string[]).includes(value);
}

function isResultStatus(value: unknown): value is JobResultStatus {
  return typeof value === "string" && (JOB_RESULT_STATUSES as readonly string[]).includes(value);
}

function isActionItemId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && /^A[1-9][0-9]*$/u.test(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
