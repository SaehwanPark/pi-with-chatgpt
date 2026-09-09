/**
 * Consultation job state machine and delivery addressing (INV-09, INV-15).
 *
 * Two contracts matter more here than convenience:
 *
 * - Transitions are an explicit allowlist. A job that reaches `completed` never goes back to
 *   `running`, and nothing reaches `completed` without having been persisted (see
 *   `ledger/record.ts`), which is what makes "persist before dispatch, persist before wake-up"
 *   checkable instead of aspirational.
 * - A result is addressed by `consultationId` plus the originating Pi session. "The session that is
 *   currently focused" is never the target, which is how asynchronous results cross-deliver.
 */

import type { ConsultationId } from "../protocol/checkpoint.js";
import type { DependencyMode } from "../protocol/dependency.js";

export const JOB_STATES = [
  "draft",
  "queued",
  "running",
  "awaiting-input",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES = ["completed", "failed", "cancelled", "expired"] as const satisfies readonly JobState[];

export function isTerminalJobState(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly JobState[]).includes(state);
}

const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  draft: ["queued", "cancelled"],
  queued: ["running", "cancelled", "expired"],
  running: ["awaiting-input", "completed", "failed", "cancelled", "expired"],
  // A waiting job can only resume into running (user finished CAPTCHA/2FA/login) or be abandoned.
  "awaiting-input": ["running", "cancelled", "expired"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalJobTransitionError extends Error {
  constructor(from: JobState, to: JobState) {
    super(`Illegal consultation job transition ${from} -> ${to}.`);
    this.name = "IllegalJobTransitionError";
  }
}

/** Mode is fixed when the job is created; an adviser failure is interpreted through it later. */
export interface JobDescriptor {
  readonly consultationId: ConsultationId;
  readonly piSessionId: string;
  readonly taskId: string;
  readonly dependency: DependencyMode;
  readonly mode: "sync" | "async";
  readonly createdAt: string;
}

/** Where a completed result must be delivered. Both fields are required (INV-09). */
export interface DeliveryAddress {
  readonly consultationId: ConsultationId;
  readonly piSessionId: string;
}

export type DeliveryOutcome =
  | { readonly kind: "delivered"; readonly address: DeliveryAddress }
  | { readonly kind: "session-gone"; readonly address: DeliveryAddress }
  | { readonly kind: "deferred"; readonly address: DeliveryAddress; readonly reason: string };
