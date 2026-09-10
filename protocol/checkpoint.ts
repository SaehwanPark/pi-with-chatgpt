/**
 * The consultation identity: the tuple that every adviser request, ledger record, and drift report
 * is keyed on (INV-03, INV-04, INV-09).
 *
 * Two properties are load-bearing and enforced here rather than by convention:
 *
 * 1. `requestedRef` (what the user or worker typed, e.g. `HEAD`, `main`) is kept *separate* from
 *    `resolvedCommit`. Persisting only the resolution loses the audit trail of what was asked for.
 * 2. `resolvedCommit` is a `FullCommitSha` and the whole record is `readonly`: an in-flight or
 *    completed consultation must not be quietly retargeted to a newer commit.
 */

import type { FullCommitSha } from "./sha.js";
import type { GitHubRepositoryKey } from "./repo.js";

/**
 * Whether the anchor object can be inspected on the *selected* GitHub remote (INV-04).
 * `unknown` is distinct from `unavailable`: an unverified remote must never be reported as
 * reachable, and a genuinely unreachable object must not be hidden behind a network error.
 */
export type RemoteAvailability =
  | { readonly status: "available" }
  | { readonly status: "unavailable"; readonly reason: RemoteUnavailableReason }
  | { readonly status: "unknown"; readonly reason: RemoteProbeFailureReason };

export type RemoteUnavailableReason =
  | "commit-not-on-remote"
  | "branch-ahead-of-remote"
  | "branch-diverged-from-remote"
  | "repository-not-pushed";

export type RemoteProbeFailureReason =
  | "network-unreachable"
  | "github-auth-failed"
  | "remote-not-configured"
  | "probe-timeout";

export function isRemoteAvailable(availability: RemoteAvailability): boolean {
  return availability.status === "available";
}

/** PR metadata is advisory context only; the SHA stays authoritative even if the PR HEAD moves. */
export interface PullRequestRef {
  readonly number: number;
  /** Full SHA of the PR HEAD at resolution time, kept for provenance, never used as the anchor. */
  readonly headCommit: FullCommitSha;
}

export interface ConsultationAnchor {
  readonly repository: GitHubRepositoryKey;
  /** Where the anchor was resolved against; a canonical `owner/repo` on a supported GitHub host. */
  readonly remoteUrl: string;
  readonly requestedRef: string;
  readonly resolvedCommit: FullCommitSha;
  readonly pullRequest?: PullRequestRef;
  readonly remoteAvailability: RemoteAvailability;
}

/** Stable per-consultation identity (`adv-…`) used for delivery routing (INV-09). */
export type ConsultationId = string & { readonly __brand: "ConsultationId" };

const CONSULTATION_ID_PATTERN = /^adv-[0-9a-z]{4,}(-[0-9a-z]+)*$/;

export function isConsultationId(value: string): value is ConsultationId {
  return CONSULTATION_ID_PATTERN.test(value);
}

/**
 * Build the identity that a consultation is dispatched with. Dispatch is refused here — before any
 * browser work — when the checkpoint is not verified reachable on the selected remote (INV-04),
 * so a caller cannot "just try anyway" by forgetting to check.
 */
export type DispatchReadiness =
  | { readonly ready: true; readonly anchor: ConsultationAnchor }
  | {
      readonly ready: false;
      readonly code: "checkpoint-not-remote";
      readonly anchor: ConsultationAnchor;
      readonly explanation: string;
    };

export function checkDispatchReadiness(anchor: ConsultationAnchor): DispatchReadiness {
  if (anchor.remoteAvailability.status === "available") return { ready: true, anchor };
  const detail =
    anchor.remoteAvailability.status === "unavailable"
      ? anchor.remoteAvailability.reason
      : anchor.remoteAvailability.reason;
  return {
    ready: false,
    code: "checkpoint-not-remote",
    anchor,
    explanation:
      `Checkpoint ${anchor.resolvedCommit.slice(0, 12)} (requested "${anchor.requestedRef}") is not inspectable ` +
      `on ${anchor.repository} (${detail}). Push the commit or choose an pushed checkpoint before consulting the adviser.`,
  };
}
