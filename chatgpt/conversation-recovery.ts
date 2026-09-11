/**
 * Conversation recovery and task handoff (INV-09, INV-14).
 *
 * A ChatGPT conversation can disappear underneath us: the user deletes it, the account changes, the
 * surface ages it out. The rule is to replace it *inside the same Project* — a replacement in a different
 * Project would break INV-08 — and to say so in the record instead of quietly reusing a dead id.
 *
 * The handoff brief is deliberately narrow. It hands over identity (task, kind, the checkpoint the old
 * conversation reviewed, the checkpoint now) and nothing else: no transcript, no repository prose, and no
 * claim that the adviser remembers anything. Continuity of *provenance* is the requirement; continuity of
 * conversation style is not, and reconstructing the latter from Project memory is the INV-14 violation
 * this module is explicitly written to prevent.
 */

import type { AdviserProjectSurface } from "../browser/runtime-types.js";
import { stateFileNameForKey, type AdviserStateLayout } from "../config/state-layout.js";
import type { FullCommitSha } from "../protocol/sha.js";
import type { GitHubRepositoryKey } from "../protocol/repo.js";
import type { StateStoreFileSystem } from "../ledger/state-store.js";
import {
  acquireStateLock,
  ensurePrivateDirectory,
  lockFilePath,
  nodeStateStore,
  type StateStoreError,
} from "../ledger/state-store.js";
import {
  conversationIsReusableFor,
  readConversationRecord,
  withConversationWriteLock,
  writeConversationRecord,
  type ChatGptConversationRecord,
  type ConversationEvent,
} from "./conversation-mapping.js";
import { conversationKeyForTask, type ChatGptConversationKey, type ConversationScope } from "./scope.js";

export type ConversationRefusalReason =
  | "state-corrupt"
  | "state-unreadable"
  | "state-busy"
  | "needs-human"
  | "start-failed"
  | "surface-unrecognised"
  | "provider-error"
  | "browser-lost";

export type EnsureConversationResult =
  | {
      readonly ok: true;
      readonly outcome: "created" | "reused" | "replaced";
      readonly record: ChatGptConversationRecord;
      readonly key: ChatGptConversationKey;
      /**
       * Present when this conversation is a replacement: the text the dispatcher must send first so the
       * adviser is not asked a follow-up cold. Sending is the dispatcher's job (M5/M6); deciding that it
       * is owed is recovery's, because only recovery knows the conversation was replaced.
       */
      readonly handoff?: TaskHandoffBrief;
      readonly note?: string;
    }
  | { readonly ok: false; readonly reason: ConversationRefusalReason; readonly explanation: string };

export interface TaskHandoffBrief {
  readonly taskId: string;
  readonly kind: ConversationScope["kind"];
  readonly previousConversationId: string;
  readonly previousCheckpoint: FullCommitSha;
  readonly currentCheckpoint: FullCommitSha;
}

export interface EnsureConversationDependencies {
  readonly layout: AdviserStateLayout;
  readonly surface: AdviserProjectSurface;
  readonly repository: GitHubRepositoryKey;
  readonly projectId: string;
  readonly scope: ConversationScope;
  /**
   * Provided when continuity matters (a follow-up): the checkpoint the previous conversation reviewed and
   * the checkpoint this request is anchored to. Recovery never guesses them.
   */
  readonly continuity?: { readonly previous: FullCommitSha; readonly current: FullCommitSha };
  readonly fileSystem?: StateStoreFileSystem;
  readonly now?: () => Date;
}

/**
 * Get a usable conversation for this task, creating or replacing one when needed.
 *
 * The whole body runs under the conversation's write lock: two follow-ups to the same task queue, while a
 * consultation for another task never waits (the lock is keyed, not global). Holding it across the
 * inspection round trip is intentional — inspecting and then starting a conversation is one write to one
 * conversation.
 */
export async function ensureConversationForTask(
  dependencies: EnsureConversationDependencies,
): Promise<EnsureConversationResult> {
  const key = conversationKeyForTask(dependencies.scope);
  const fileSystem = dependencies.fileSystem ?? nodeStateStore;
  if (!isOpaqueId(dependencies.projectId)) {
    return {
      ok: false,
      reason: "surface-unrecognised",
      explanation: "The recorded ChatGPT Project id is not a usable opaque id; no conversation was started.",
    };
  }
  try {
    await ensurePrivateDirectory(dependencies.layout.locksDir, fileSystem);
    return await withConversationWriteLock(key, async () => {
      let lock;
      try {
        lock = await acquireStateLock({
          path: lockFilePath(
            dependencies.layout.locksDir,
            stateFileNameForKey("conversation", key, "lock").replace(/\.lock$/u, ""),
          ),
          fileSystem,
        });
      } catch (error) {
        return { ok: false, reason: stateReason(error), explanation: stateExplanation(error) };
      }
      try {
        return await ensureInsideLock({ ...dependencies, fileSystem }, key);
      } catch (error) {
        return { ok: false, reason: stateReason(error), explanation: stateExplanation(error) };
      } finally {
        await lock.release();
      }
    });
  } catch (error) {
    return { ok: false, reason: stateReason(error), explanation: stateExplanation(error) };
  }
}

async function ensureInsideLock(
  dependencies: EnsureConversationDependencies,
  key: ChatGptConversationKey,
): Promise<EnsureConversationResult> {
  const fileSystem = dependencies.fileSystem ?? nodeStateStore;
  const now = dependencies.now ?? (() => new Date());
  await ensurePrivateDirectory(dependencies.layout.conversationsDir, fileSystem);

  const read = await readConversationRecord(dependencies.layout, key, fileSystem);
  if (read.corrupt) {
    return {
      ok: false,
      reason: "state-corrupt",
      explanation: `The conversation record for this task is unreadable and was not overwritten; refusing to start a second thread for the same task.`,
    };
  }

  const existing = read.record;
  // Narrowing is captured in a boolean on purpose: inside the branch `existing` is still
  // `| undefined`, and the helper's job is to say *why* it is unusable, not to assert it is absent.
  const reusable = conversationIsReusableFor(existing, { projectId: dependencies.projectId, key });

  if (reusable && existing !== undefined) {
    const record = existing;
    const inspection = await dependencies.surface.inspectConversation(record.conversationId);
    if (inspection.state === "live") {
      const touched = stamp(record, "reused", now(), {
        conversationUrl: inspection.conversationUrl ?? record.conversationUrl ?? canonicalConversationUrl(record.conversationId),
      });
      await writeConversationRecord(dependencies.layout, touched, fileSystem);
      return { ok: true, outcome: "reused", record: touched, key };
    }
    if (inspection.state === "unknown") {
      // Inconclusive is not "gone": replacing a live conversation would orphan the thread that already
      // holds this task's context.
      return {
        ok: true,
        outcome: "reused",
        record,
        key,
        note: `ChatGPT could not confirm the conversation (${inspection.reason}); keeping the recorded one.`,
      };
    }
    return await startReplacement({ ...dependencies, fileSystem, now }, key, record);
  }

  // A record in another Project, or one already marked stale/replaced, cannot be reused. Open a fresh
  // thread in the requested Project and retain the old id as `replacedFromConversationId` below.
  if (existing !== undefined) return await startReplacement({ ...dependencies, fileSystem, now }, key, existing);

  const started = await dependencies.surface.startConversation(dependencies.projectId);
  if (!started.ok) {
    return { ok: false, reason: startReason(started.reason), explanation: startExplanation(started.reason) };
  }
  if (!isOpaqueId(started.conversationId)) {
    return {
      ok: false,
      reason: "surface-unrecognised",
      explanation: "ChatGPT reported a conversation without a usable opaque id; no conversation record was written.",
    };
  }
  const timestamp = now().toISOString();
  const record: ChatGptConversationRecord = {
    conversationKey: key,
    repository: dependencies.repository,
    projectId: dependencies.projectId,
    taskId: dependencies.scope.taskId,
    kind: dependencies.scope.kind,
    conversationId: started.conversationId,
    conversationUrl: canonicalConversationUrl(started.conversationId),
    createdAt: timestamp,
    lastUsedAt: timestamp,
    state: "active",
    revision: 1,
    lastEvent: "created",
  };
  await writeConversationRecord(dependencies.layout, record, fileSystem);
  return { ok: true, outcome: "created", record, key };
}

/**
 * Replace a dead conversation inside the same Project.
 *
 * The caller may name both checkpoints (`continuity`); when it does, the result carries the handoff text
 * the dispatcher must send first. Recovery does not invent checkpoints: absent continuity the outcome is
 * still a working conversation, just without a handoff.
 */
async function startReplacement(
  dependencies: EnsureConversationDependencies & { readonly fileSystem: StateStoreFileSystem; readonly now: () => Date },
  key: ChatGptConversationKey,
  dead: ChatGptConversationRecord,
): Promise<EnsureConversationResult> {
  const started = await dependencies.surface.startConversation(dependencies.projectId);
  if (!started.ok) {
    return { ok: false, reason: startReason(started.reason), explanation: startExplanation(started.reason) };
  }
  if (!isOpaqueId(started.conversationId)) {
    return {
      ok: false,
      reason: "surface-unrecognised",
      explanation: "ChatGPT reported a conversation without a usable opaque id; no conversation record was written.",
    };
  }
  const timestamp = dependencies.now().toISOString();
  const record: ChatGptConversationRecord = {
    conversationKey: key,
    repository: dependencies.repository,
    projectId: dependencies.projectId,
    taskId: dependencies.scope.taskId,
    kind: dependencies.scope.kind,
    conversationId: started.conversationId,
    conversationUrl: canonicalConversationUrl(started.conversationId),
    createdAt: timestamp,
    lastUsedAt: timestamp,
    state: "active",
    // The returned handoff is ready for the dispatcher; `handoffAt` remains unset until it is actually sent.
    replacedFromConversationId: dead.conversationId,
    replacedFromConversationUrl: dead.conversationUrl ?? canonicalConversationUrl(dead.conversationId),
    revision: 1,
    lastEvent: "replaced",
  };
  await writeConversationRecord(dependencies.layout, record, dependencies.fileSystem);
  const handoff: TaskHandoffBrief | undefined =
    dependencies.continuity === undefined
      ? undefined
      : {
          taskId: dependencies.scope.taskId,
          kind: dependencies.scope.kind,
          previousConversationId: dead.conversationId,
          previousCheckpoint: dependencies.continuity.previous,
          currentCheckpoint: dependencies.continuity.current,
        };
  return {
    ok: true,
    outcome: "replaced",
    record,
    key,
    ...(handoff === undefined ? {} : { handoff }),
    note: "The adviser conversation was deleted; a replacement was started in the same Project.",
  };
}

function stamp(
  record: ChatGptConversationRecord,
  event: ConversationEvent,
  date: Date,
  patch: Partial<ChatGptConversationRecord> = {},
): ChatGptConversationRecord {
  return {
    ...record,
    ...patch,
    lastEvent: event,
    lastUsedAt: date.toISOString(),
    revision: record.revision + 1,
  };
}

/**
 * Render the handoff for a replacement conversation.
 *
 * Both checkpoints are named so the adviser knows the previous answer was about a different commit, and
 * the instruction to read GitHub (rather than trust the prose) is part of the brief: a handoff that
 * summarised the old conversation would be using memory as provenance (INV-14).
 */
export function renderTaskHandoff(brief: TaskHandoffBrief): string {
  return [
    "TASK HANDOFF — this conversation replaces one that was deleted.",
    `Task: ${brief.taskId}`,
    `Request kind: ${brief.kind}`,
    `Previous conversation reviewed ${brief.previousCheckpoint}.`,
    `This request is anchored to ${brief.currentCheckpoint}.`,
    "Do not rely on Project memory or on this handoff for repository facts: inspect the repository at the checkpoint above through GitHub.",
  ].join("\n");
}

/** Guard used by the dispatcher: a handoff may never be the only source of the checkpoint claim. */
export function assertProvenanceIsCheckpointAnchored(text: string, checkpoint: FullCommitSha): void {
  if (!text.includes(checkpoint)) {
    throw new Error(
      "Refusing to send adviser text that does not name the checkpoint it is anchored to; provenance must come from the consultation record, not conversation memory (INV-14).",
    );
  }
}

function startReason(reason: "name-taken" | "needs-human" | "surface-unrecognised" | "provider-error" | "browser-lost"): ConversationRefusalReason {
  if (reason === "name-taken") return "start-failed";
  return reason;
}

function startExplanation(reason: ConversationRefusalReason | "name-taken"): string {
  switch (reason) {
    case "needs-human":
      return "ChatGPT asked for a sign-in or verification before a conversation could be opened.";
    case "surface-unrecognised":
      return "The ChatGPT conversation surface did not match the expected controls; the adviser UI may have changed.";
    case "provider-error":
    case "name-taken":
      return "ChatGPT refused to open a conversation; retry once, then report it if it persists.";
    case "browser-lost":
      return "The adviser browser stopped responding before a conversation could be opened.";
    default:
      return "The adviser conversation could not be opened.";
  }
}

function isStateStoreError(error: unknown): error is StateStoreError {
  return error instanceof Error && ["state-busy", "state-corrupt", "state-unreadable"].includes((error as StateStoreError).code);
}

function stateReason(error: unknown): ConversationRefusalReason {
  if (isStateStoreError(error) && error.code === "state-busy") return "state-busy";
  if (isStateStoreError(error) && error.code === "state-corrupt") return "state-corrupt";
  return "state-unreadable";
}

function stateExplanation(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Adviser conversation state is busy or unreadable, so no second conversation was started: ${message}`;
}

function canonicalConversationUrl(conversationId: string): string {
  if (!/^[A-Za-z0-9_-]{4,120}$/u.test(conversationId)) {
    throw new Error(`Invalid ChatGPT conversation id: ${conversationId.slice(0, 24)}`);
  }
  return `https://chatgpt.com/g/${encodeURIComponent(conversationId)}`;
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9_-]{4,120}$/u.test(value);
}
