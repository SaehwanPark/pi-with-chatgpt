/**
 * Project and conversation scoping (INV-08, INV-09).
 *
 * One ChatGPT Project maps to one GitHub repository, keyed by canonical repository identity — never
 * by session, branch, task, or working directory, because those vary per Pi run and would multiply
 * Projects for the same repository. Inside a Project, each Pi task gets its own conversation, keyed
 * by task identity, so unrelated consultations cannot cross-deliver or contaminate each other.
 */

import type { GitHubRepositoryKey } from "../protocol/repo.js";
import type { ConsultationId } from "../protocol/checkpoint.js";

export type ChatGptProjectKey = string & { readonly __brand: "ChatGptProjectKey" };
export type ChatGptConversationKey = string & { readonly __brand: "ChatGptConversationKey" };

import {
  CONSULTATION_KINDS,
  type ConsultationKind,
  isConsultationKind,
} from "../protocol/brief.js";

export { CONSULTATION_KINDS, type ConsultationKind, isConsultationKind };

/**
 * The Project key is deliberately the bare repository key: the same repository must resolve to the
 * same Project across branches, sessions, and tasks. `adviser:` is a namespace prefix so a future
 * (post-V1, decision-gated) second provider cannot collide with it silently.
 */
export function projectKeyForRepository(repository: GitHubRepositoryKey): ChatGptProjectKey {
  return `adviser:github:${repository}` as ChatGptProjectKey;
}

export interface ConversationScope {
  readonly repository: GitHubRepositoryKey;
  /** Stable Pi task identity (session + task), never a timestamp: retries must reuse a conversation. */
  readonly taskId: string;
  readonly kind: ConsultationKind;
}

/**
 * Task conversations are keyed by repository + task + kind. The kind is included so a plan and a
 * code review of the same task do not share a thread, which keeps advice attributable when a task
 * pivots from one request type to another.
 */
export function conversationKeyForTask(scope: ConversationScope): ChatGptConversationKey {
  const taskId = scope.taskId.trim();
  if (taskId.length === 0) {
    throw new Error("Adviser conversations require a task identity; a repository-wide shared thread is prohibited (INV-09).");
  }
  // Percent-encoding keeps the key unambiguous: a task id containing the `:` separator must not be
  // able to imitate another repository, task, or kind.
  const encodedTask = encodeURIComponent(taskId);
  return `adviser:github:${scope.repository}:task:${encodedTask}:${scope.kind}` as ChatGptConversationKey;
}

/**
 * Delivery routing: an asynchronous result is addressed to a consultation id, never to "the current
 * session", which is how cross-delivery happens. See `jobs/state.ts`.
 */
export interface ConversationAddress {
  readonly conversation: ChatGptConversationKey;
  readonly consultationId: ConsultationId;
}
