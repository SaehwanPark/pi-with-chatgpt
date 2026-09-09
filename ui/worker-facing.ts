/**
 * The worker-facing advice surface (INV-13).
 *
 * The worker model receives a structured, minimal view of a consultation. Everything that would
 * teach it how the machinery works — DOM details, conversation or Project URLs, browser profile
 * paths, polling state, OAuth material — is excluded by an allowlist rather than by removal
 * heuristics. The `pi-with-chatgpt` contract is: here is the advice, here is the checkpoint it was
 * about, here is how stale it is, and here are the decisions still open.
 */

import type { LedgerRecord } from "../ledger/record.js";
import type { DriftVerdict } from "../drift/index.js";
import type { AdviceCurrency } from "../drift/index.js";

export interface WorkerFacingCheckpoint {
  readonly requestedRef: string;
  readonly resolvedCommit: string;
}

export interface WorkerFacingActionItem {
  readonly ordinal: number;
  readonly summary: string;
  readonly disposition: LedgerRecord["actionItems"][number]["disposition"];
}

export interface WorkerFacingAdvisory {
  readonly consultationId: string;
  readonly kind: LedgerRecord["kind"];
  readonly state: LedgerRecord["state"];
  readonly dependency: LedgerRecord["dependency"];
  readonly checkpoint: WorkerFacingCheckpoint;
  readonly drift?: { readonly verdict: DriftVerdict; readonly currency: AdviceCurrency };
  readonly advice?: string;
  readonly actionItems: readonly WorkerFacingActionItem[];
  /** Present when the adviser failed; says what the worker should do, not why the browser broke. */
  readonly degradation?: { readonly reason: string; readonly nextStep: string };
}

/** Keys that must never reach the worker; asserted by a test over the built type's key list. */
// Note: this list is about *secrecy and opacity* (INV-13), not about correctness of the value.
export const WORKER_FACING_FORBIDDEN_KEY_PATTERN =
  /(dom|selector|xpath|screenshot|html|conversationurl|projecturl|userdata|user_data|profile|cookie|token|oauth|authorization|refreshtoken|pollstate|rawresponse)/iu;

export function toWorkerFacingAdvisory(
  record: LedgerRecord,
  options: { readonly drift?: { readonly verdict: DriftVerdict; readonly currency: AdviceCurrency }; readonly degradation?: { readonly reason: string; readonly nextStep: string } } = {},
): WorkerFacingAdvisory {
  return {
    consultationId: record.consultationId,
    kind: record.kind,
    state: record.state,
    dependency: record.dependency,
    checkpoint: { requestedRef: record.requestedRef, resolvedCommit: record.resolvedCommit },
    ...(options.drift === undefined ? {} : { drift: options.drift }),
    ...(record.adviserAnswer === undefined ? {} : { advice: record.adviserAnswer }),
    actionItems: record.actionItems.map((item) => ({
      ordinal: item.ordinal,
      summary: item.summary,
      disposition: item.disposition,
    })),
    ...(options.degradation === undefined ? {} : { degradation: options.degradation }),
  };
}

/** Convenience for the many places that need "is this key safe to show a worker". */
export function isWorkerFacingKey(key: string): boolean {
  return !WORKER_FACING_FORBIDDEN_KEY_PATTERN.test(key);
}
