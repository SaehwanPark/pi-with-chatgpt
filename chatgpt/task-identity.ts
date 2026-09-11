/**
 * Task and Pi-session identity: the key that decides which adviser conversation a request belongs
 * to (INV-09).
 *
 * The whole isolation story depends on this being *stable but not too stable*:
 *
 * - Stable across retries and follow-ups, so the same task reuses its conversation instead of opening a
 *   fresh thread for every attempt.
 * - Not shared across unrelated tasks, which is why the identity never falls back to "the repository" or
 *   "the current session of whoever is fastest".
 * - Independent of things that legitimately move during a task: the branch, the HEAD SHA, the worktree
 *   path, and the wall clock. Keying a conversation on any of them would silently fork the advice thread
 *   halfway through a task, and the adviser would lose the context the follow-up assumes.
 */

export type TaskIdentity = string & { readonly __brand: "TaskIdentity" };

/** Where the identity came from, surfaced because a fallback has weaker isolation guarantees. */
export type TaskIdentityOrigin = "explicit" | "pi-session" | "workspace-fallback";

export interface TaskIdentityInput {
  /** Caller-supplied task label (`--task`, or the tool's `task` argument). Wins when present. */
  readonly explicitTaskId?: string;
  /** Pi's session id: stable for one Pi run, which is the closest thing V1 has to a task. */
  readonly piSessionId?: string;
  /** Absolute workspace path. Hashed into the id, never embedded, so no local path leaks. */
  readonly workspacePath?: string;
}

export interface ResolvedTaskIdentity {
  readonly taskId: TaskIdentity;
  readonly origin: TaskIdentityOrigin;
  /** Warning for the status surface when the identity is weaker than the caller asked for. */
  readonly note?: string;
}

export const MAX_TASK_ID_LENGTH = 96;

/**
 * Characters allowed in a task id after normalization.
 *
 * Anything else is dropped rather than percent-encoded: an id with opaque escapes in it is a worse
 * conversation label for a human reading `/advisor-status` than a shortened one, and the repository key
 * is already percent-encoded separately (`chatgpt/scope.ts`).
 */
const UNSAFE_TASK_ID_CHARACTERS = /[^A-Za-z0-9._-]+/gu;

export function deriveTaskIdentity(input: TaskIdentityInput): ResolvedTaskIdentity {
  const explicit = normalize(input.explicitTaskId);
  if (explicit !== undefined) {
    return { taskId: explicit as TaskIdentity, origin: "explicit" };
  }
  const session = normalize(input.piSessionId);
  if (session !== undefined) {
    return { taskId: session as TaskIdentity, origin: "pi-session" };
  }
  // Last resort: a workspace-scoped id. It keeps unrelated repositories apart but shares one thread
  // across unrelated tasks in the same checkout, so it is reported rather than presented as safe.
  const fallback = `workspace-${shortHash(input.workspacePath?.trim() ?? "unknown-workspace")}`;
  return {
    taskId: fallback as TaskIdentity,
    origin: "workspace-fallback",
    note: "No task or Pi session identity was available; unrelated tasks in this workspace share one adviser conversation.",
  };
}

/**
 * Normalization, not validation: an advisory call must not fail because the label was untidy.
 *
 * Control characters and separators are the interesting cases — a task id containing `:` could otherwise
 * imitate another repository's key, which is why `conversationKeyForTask` percent-encodes it as well.
 */
function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(UNSAFE_TASK_ID_CHARACTERS, "-").replace(/^-+|-+$/gu, "");
  if (collapsed.length === 0) return undefined;
  return collapsed.slice(0, MAX_TASK_ID_LENGTH);
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
