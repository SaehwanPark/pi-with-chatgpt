/**
 * Task conversation mapping and write serialisation (INV-09).
 *
 * One conversation per (repository, task, request kind), stored beside the Project mapping so a follow-up
 * in a later Pi session can find the thread that already has the context. Two properties matter:
 *
 * - **Reuse where continuity is real.** A retry or a follow-up of the same task reuses the conversation;
 *   an unrelated task never inherits it, because the key is derived from task identity rather than from
 *   "the most recent conversation we know about".
 * - **One writer per conversation.** Two dispatches typing into one ChatGPT conversation produce an
 *   unattributable answer, so writes are serialised per conversation key — and deliberately *only* per
 *   key, because two independent tasks must be able to consult in parallel.
 */

import type { AdviserStateLayout } from "../config/state-layout.js";
import { conversationKeyForTask, isConsultationKind, type ConsultationKind } from "./scope.js";
import type { GitHubRepositoryKey } from "../protocol/repo.js";
import type { StateStoreFileSystem } from "../ledger/state-store.js";
import { assertCredentialFreeValue } from "../ledger/record.js";
import {
  ensurePrivateDirectory,
  nodeStateStore,
  readJsonFile,
  writeJsonFileAtomically,
  StateStoreError,
} from "../ledger/state-store.js";
import { stateFileNameForKey } from "../config/state-layout.js";
import type { ChatGptConversationKey } from "./scope.js";

export const CONVERSATION_SCHEMA_VERSION = 1;

export const CONVERSATION_STATES = ["active", "stale", "replaced"] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const CONVERSATION_EVENTS = [
  "created",
  "reused",
  "marked-stale",
  "replaced",
  "handoff-sent",
] as const;
export type ConversationEvent = (typeof CONVERSATION_EVENTS)[number];

export interface ChatGptConversationRecord {
  readonly conversationKey: ChatGptConversationKey;
  readonly repository: GitHubRepositoryKey;
  /** The Project this conversation lives in. A different Project id means the record is stale (INV-08). */
  readonly projectId: string;
  readonly taskId: string;
  readonly kind: ConsultationKind;
  readonly conversationId: string;
  /** Canonical ChatGPT URL retained for operator navigation; the id remains authoritative. */
  readonly conversationUrl?: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly state: ConversationState;
  /** Set when this record was superseded, so history stays readable instead of being deleted. */
  readonly replacedBy?: string;
  /** Replacement records point back to the dead thread so recovery remains durable in one task file. */
  readonly replacedFromConversationId?: string;
  readonly replacedFromConversationUrl?: string;
  /** Set once the task handoff has been sent into a replacement conversation. */
  readonly handoffAt?: string;
  readonly revision: number;
  readonly lastEvent: ConversationEvent;
}

export interface ConversationRecordFile {
  readonly version: number;
  readonly record: ChatGptConversationRecord;
}

export function conversationFilePath(layout: AdviserStateLayout, key: ChatGptConversationKey): string {
  return `${layout.conversationsDir}/${stateFileNameForKey("conversation", key, "json")}`;
}

export function parseConversationFile(raw: unknown): ConversationRecordFile | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const candidate = raw as { version?: unknown; record?: unknown };
  if (candidate.version !== CONVERSATION_SCHEMA_VERSION) return undefined;
  const record = candidate.record;
  if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
  const value = record as Record<string, unknown>;
  for (const field of [
    "conversationKey",
    "repository",
    "projectId",
    "taskId",
    "kind",
    "conversationId",
    "createdAt",
    "lastUsedAt",
    "state",
    "lastEvent",
  ] as const) {
    const rawField = value[field];
    if (typeof rawField !== "string" || rawField.length === 0) return undefined;
  }
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 1) return undefined;
  if (!CONVERSATION_STATES.includes(value.state as ConversationState)) return undefined;
  if (!CONVERSATION_EVENTS.includes(value.lastEvent as ConversationEvent)) return undefined;
  if (!isConsultationKind(value.kind as string)) return undefined;
  if (!isOpaqueId(value.projectId as string)) return undefined;
  if (!isOpaqueId(value.conversationId as string)) return undefined;
  if (
    value.conversationUrl !== undefined &&
    (!isCanonicalConversationUrl(value.conversationUrl) || value.conversationUrl !== canonicalConversationUrl(value.conversationId as string))
  ) {
    return undefined;
  }
  if (value.replacedFromConversationId !== undefined && !isOpaqueId(value.replacedFromConversationId as string)) {
    return undefined;
  }
  if (value.replacedBy !== undefined && !isOpaqueId(value.replacedBy as string)) return undefined;
  if (value.replacedFromConversationUrl !== undefined) {
    if (!isCanonicalConversationUrl(value.replacedFromConversationUrl)) return undefined;
    if (
      value.replacedFromConversationId === undefined ||
      value.replacedFromConversationUrl !== canonicalConversationUrl(value.replacedFromConversationId as string)
    ) {
      return undefined;
    }
  }
  if (
    conversationKeyForTask({
      repository: value.repository as GitHubRepositoryKey,
      taskId: value.taskId as string,
      kind: value.kind as ConsultationKind,
    }) !== value.conversationKey
  ) {
    return undefined;
  }
  try {
    assertCredentialFreeValue("conversation record", record);
  } catch {
    return undefined;
  }
  return { version: CONVERSATION_SCHEMA_VERSION, record: record as ChatGptConversationRecord };
}

export interface ConversationRead {
  readonly record: ChatGptConversationRecord | undefined;
  readonly corrupt: boolean;
}

export async function readConversationRecord(
  layout: AdviserStateLayout,
  key: ChatGptConversationKey,
  fileSystem: StateStoreFileSystem = nodeStateStore,
): Promise<ConversationRead> {
  const path = conversationFilePath(layout, key);
  const result = await readJsonFile<ConversationRecordFile>(path, parseConversationFile, fileSystem);
  if (!result.ok) return { record: undefined, corrupt: true };
  if (result.value === undefined) return { record: undefined, corrupt: false };
  // A record stored under one key but naming another is a mismatch we refuse rather than adopt: silently
  // accepting it is how advice from task A lands in task B's thread.
  if (result.value.record.conversationKey !== key) return { record: undefined, corrupt: true };
  return { record: result.value.record, corrupt: false };
}

export async function writeConversationRecord(
  layout: AdviserStateLayout,
  record: ChatGptConversationRecord,
  fileSystem: StateStoreFileSystem = nodeStateStore,
): Promise<void> {
  assertCredentialFreeValue("conversation record", record);
  const file: ConversationRecordFile = { version: CONVERSATION_SCHEMA_VERSION, record };
  if (parseConversationFile(file) === undefined) {
    throw new StateStoreError(
      "state-corrupt",
      conversationFilePath(layout, record.conversationKey),
      "Refusing to persist a conversation record that does not match the M4 schema.",
    );
  }
  await ensurePrivateDirectory(layout.conversationsDir, fileSystem);
  await writeJsonFileAtomically(conversationFilePath(layout, record.conversationKey), file, fileSystem);
}

export function conversationIsReusableFor(
  record: ChatGptConversationRecord | undefined,
  expected: { readonly projectId: string; readonly key: ChatGptConversationKey },
): boolean {
  if (record === undefined) return false;
  if (record.state !== "active") return false;
  // A conversation inside a different Project is a broken mapping, not a reusable thread: the Project
  // that owned it was deleted or the repository was remapped (INV-08).
  return record.projectId === expected.projectId && record.conversationKey === expected.key;
}

/**
 * Per-key async mutex.
 *
 * Rejections are as important as acquisitions here: a failed body must release the key, or one failed
 * consultation would wedge that conversation for the rest of the process. The tail entry is deleted only
 * when the waiter chain drains, so the map cannot grow with the number of tasks ever seen.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await body();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  /** Whether a body is queued for `key`; used by tests and by the status surface. */
  isContended(key: string): boolean {
    return this.#tails.has(key);
  }
}

/** Process-wide default. Callers may construct their own for tests or for a second state root. */
export const conversationWriteMutex = new KeyedMutex();

/** Convenience wrapper: run `body` while holding this conversation's write lock. */
export function withConversationWriteLock<T>(
  key: ChatGptConversationKey,
  body: () => Promise<T>,
  mutex: KeyedMutex = conversationWriteMutex,
): Promise<T> {
  return mutex.run(key, body);
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9_-]{4,120}$/u.test(value);
}

function isCanonicalConversationUrl(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/chatgpt\.com\/g\/[A-Za-z0-9_-]{4,120}$/u.test(value);
}

function canonicalConversationUrl(conversationId: string): string {
  return `https://chatgpt.com/g/${encodeURIComponent(conversationId)}`;
}
