/**
 * Durable consultation provenance (INV-12, INV-15).
 *
 * The ledger is the audit trail that makes advice evaluable after the fact. Two rules are enforced
 * by these types instead of by discipline:
 *
 * - **Persistence precedes side effects.** A job record is written before dispatch and the result is
 *   written before the Pi session is woken, so a crash cannot leave an advice that only existed in
 *   model context. `assertPersistenceOrder` is the check the M5 engine is expected to call.
 * - **The ledger holds no credentials and is never published.** Sensitive key names and secret-shaped
 *   values are rejected on write, and the only publication target is `"none"`: publishing advice to
 *   a repository file, issue, or PR is always an explicit human action outside this extension.
 */

import type { FullCommitSha } from "../protocol/sha.js";
import type { GitHubRepositoryKey } from "../protocol/repo.js";
import type { ConsultationId } from "../protocol/checkpoint.js";
import type { ConsultationKind } from "../chatgpt/scope.js";
import type { DependencyMode } from "../protocol/dependency.js";
import type { JobState } from "../jobs/state.js";

/** INV-15: the ledger is local. There is deliberately no "issue"/"pr-comment" target. */
export const LEDGER_PUBLICATION_TARGETS = ["none"] as const;
export type LedgerPublicationTarget = (typeof LEDGER_PUBLICATION_TARGETS)[number];

export interface LedgerActionItem {
  readonly ordinal: number;
  readonly summary: string;
  readonly disposition: "pending" | "accepted" | "rejected" | "deferred" | "completed";
  readonly dispositionNote?: string;
}

export interface LedgerRecord {
  readonly consultationId: ConsultationId;
  readonly kind: ConsultationKind;
  readonly dependency: DependencyMode;
  readonly repository: GitHubRepositoryKey;
  readonly requestedRef: string;
  readonly resolvedCommit: FullCommitSha;
  readonly state: JobState;
  readonly requestBrief: string;
  readonly adviserAnswer?: string;
  readonly actionItems: readonly LedgerActionItem[];
  readonly dispatchedAt?: string;
  readonly completedAt?: string;
  readonly failureReason?: string;
  /** Never a token, cookie, profile path, or account identifier: provenance and text only. */
  readonly notes?: string;
}

/** Keys that must never appear in a ledger record, at any depth. */
export const SENSITIVE_LEDGER_KEY_PATTERN =
  /(cookie|authorization|token|secret|password|passwd|credential|apikey|api_key|sessionid|session_id|bearer|oauth|accesskey|privatekey|userdata|user_data|profilepath|profile_path)/iu;

/** Value shapes that indicate a credential leaked into prose. */
export const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bsk-[A-Za-z0-9_-]{16,}/u,
  /set-cookie\s*:/iu,
  /cookie\s*:[^\n]{8,}/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

export class UnsafeLedgerRecordError extends Error {
  constructor(reason: string) {
    super(`Refusing to persist ledger record: ${reason}`);
    this.name = "UnsafeLedgerRecordError";
  }
}

export function assertLedgerRecordSafe(record: LedgerRecord): void {
  walk(record, (key, value) => {
    if (SENSITIVE_LEDGER_KEY_PATTERN.test(key)) {
      throw new UnsafeLedgerRecordError(`field "${key}" looks like credential material`);
    }
    if (typeof value === "string") {
      const pattern = SENSITIVE_VALUE_PATTERNS.find((candidate) => candidate.test(value));
      if (pattern !== undefined) {
        throw new UnsafeLedgerRecordError(`field "${key || "<root>"}" matches the secret pattern ${pattern}`);
      }
    }
  });
}

function walk(value: unknown, visit: (key: string, value: unknown) => void, ancestors: readonly object[] = []): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit, ancestors);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  // Cycles would only come from caller error, but a stack overflow is a bad way to find out.
  if (ancestors.includes(value)) return;
  const nested = [...ancestors, value];
  for (const [key, entry] of Object.entries(value)) {
    visit(key, entry);
    walk(entry, visit, nested);
  }
}

export const PERSISTENCE_STEPS = ["job-persisted", "dispatched", "response-persisted", "delivered"] as const;
export type PersistenceStep = (typeof PERSISTENCE_STEPS)[number];

/**
 * Enforce "persist before dispatch, persist before wake-up" (INV-15).
 *
 * The check fails closed: a missing persistence step is treated as a violation, not as "nothing to
 * check". A caller that dispatched without ever recording `job-persisted` is exactly the history we
 * are trying to prevent, so omission must not be the way to pass this guard.
 */
export function assertPersistenceOrder(steps: readonly PersistenceStep[]): void {
  const index = (step: PersistenceStep): number => steps.indexOf(step);
  const dispatched = index("dispatched");
  if (dispatched !== -1) {
    const persisted = index("job-persisted");
    if (persisted === -1) {
      throw new UnsafeLedgerRecordError("job was dispatched without a recorded job-persisted step");
    }
    if (persisted > dispatched) {
      throw new UnsafeLedgerRecordError("job must be persisted before dispatch");
    }
  }
  const delivered = index("delivered");
  if (delivered !== -1) {
    const persisted = index("response-persisted");
    if (persisted === -1) {
      throw new UnsafeLedgerRecordError("response was delivered without a recorded response-persisted step");
    }
    if (persisted > delivered) {
      throw new UnsafeLedgerRecordError("response must be persisted before session wake-up");
    }
  }
}
