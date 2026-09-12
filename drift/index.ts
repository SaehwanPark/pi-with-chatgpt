/**
 * `drift/` — relationship between the adviser checkpoint and the current development cursor.
 *
 * The advice cursor (the commit the adviser saw) and the development cursor (current HEAD) move
 * independently. This module's vocabulary keeps them separate instead of pretending a later HEAD is
 * "the same code plus a little". Full graph analysis and action-item disposition land in M7.
 */

export const DRIFT_VERDICTS = [
  "equal",
  /** Advice is about an ancestor of HEAD: still valid, but newer commits may have addressed it. */
  "checkpoint-is-ancestor",
  /** Advice is about a commit ahead of HEAD (different branch/worktree). */
  "checkpoint-is-descendant",
  /** Neither is an ancestor of the other: the two histories disagree. */
  "diverged",
  /** The checkpoint object is gone or was never reachable. */
  "unreachable",
] as const;

export type DriftVerdict = (typeof DRIFT_VERDICTS)[number];

/**
 * How usable advice is given a verdict. `stale` never means "wrong": it means the worker must
 * re-verify against current code before acting (INV-05).
 */
export type AdviceCurrency = "current" | "possibly-stale" | "unreliable";

export interface DriftReport {
  /** Full SHA the advice was about. */
  readonly checkpoint: string;
  /** Full SHA at analysis time. */
  readonly currentHead: string;
  readonly verdict: DriftVerdict;
  readonly commitsFromCheckpointToHead?: number;
  readonly commitsFromHeadToCheckpoint?: number;
  readonly currency: AdviceCurrency;
}

export function adviceCurrencyFor(verdict: DriftVerdict): AdviceCurrency {
  switch (verdict) {
    case "equal":
      return "current";
    case "checkpoint-is-ancestor":
      return "possibly-stale";
    case "checkpoint-is-descendant":
    case "diverged":
      return "unreliable";
    case "unreachable":
      return "unreliable";
  }
}

export * from "./graph-drift.js";
export * from "./file-drift.js";
export * from "./classification.js";
export * from "./disposition.js";
export * from "./follow-up.js";
