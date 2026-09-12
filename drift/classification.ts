/**
 * Advice revalidation classification and drift notes (INV-01, INV-05).
 *
 * Combines graph-level ancestry with file-level change analysis to classify
 * consultation advice currency and generate concise guidance for the Pi worker.
 */

import type { GraphDriftResult } from "./graph-drift.js";
import type { RelevantFileDrift } from "./file-drift.js";

export const ADVICE_CLASSIFICATIONS = [
  "current",
  "likely_applicable",
  "materially_stale",
  "needs_reconsultation",
  "provenance_degraded",
] as const;

export type AdviceClassification = (typeof ADVICE_CLASSIFICATIONS)[number];

export interface RevalidationReport {
  readonly classification: AdviceClassification;
  readonly graphDrift: GraphDriftResult;
  readonly fileDrift?: RelevantFileDrift;
  readonly summaryNote: string;
  readonly affectedActionItemIds: readonly string[];
  readonly recommendedAction: string;
}

/**
 * Classifies the currency and validity of advice relative to the current cursor.
 */
export function classifyAdviceStatus(
  graph: GraphDriftResult,
  fileDrift?: RelevantFileDrift,
  actionItems: readonly { readonly id: string; readonly summary: string }[] = [],
  provenanceDegraded = false,
): RevalidationReport {
  if (provenanceDegraded || graph.verdict === "unreachable") {
    return {
      classification: "provenance_degraded",
      graphDrift: graph,
      fileDrift,
      summaryNote: `Checkpoint ${graph.checkpoint.slice(0, 7)} is unreachable on remote. Provenance is degraded.`,
      affectedActionItemIds: actionItems.map((a) => a.id),
      recommendedAction: "Verify commit availability or re-anchor consultation.",
    };
  }

  if (graph.verdict === "equal") {
    return {
      classification: "current",
      graphDrift: graph,
      fileDrift,
      summaryNote: `Adviser reviewed ${graph.checkpoint.slice(0, 7)} which matches current HEAD.`,
      affectedActionItemIds: [],
      recommendedAction: "Apply recommendations normally.",
    };
  }

  if (graph.verdict === "diverged" || graph.verdict === "checkpoint-is-descendant") {
    const detail = graph.verdict === "diverged"
      ? `Histories diverged (${graph.commitsAhead} ahead, ${graph.commitsBehind} behind)`
      : `Checkpoint is ahead of current HEAD (${graph.commitsBehind} behind)`;

    return {
      classification: "needs_reconsultation",
      graphDrift: graph,
      fileDrift,
      summaryNote: `Adviser reviewed ${graph.checkpoint.slice(0, 7)}. ${detail}. Current HEAD is ${graph.currentHead.slice(0, 7)}.`,
      affectedActionItemIds: actionItems.map((a) => a.id),
      recommendedAction: "Consider a follow-up consultation on the current branch.",
    };
  }

  // At this point, verdict is "checkpoint-is-ancestor"
  const directlyAffected = fileDrift?.directlyAffectedFiles ?? [];
  const relatedContext = fileDrift?.relatedContextFiles ?? [];

  // Determine affected action items
  const affectedActionItemIds: string[] = [];
  if (directlyAffected.length > 0) {
    for (const item of actionItems) {
      const mentionsDirectlyAffected = directlyAffected.some((file) => item.summary.includes(file));
      if (mentionsDirectlyAffected) {
        affectedActionItemIds.push(item.id);
      }
    }
  }

  const classification: AdviceClassification =
    directlyAffected.length > 0 ? "materially_stale" : "likely_applicable";

  const allDriftFiles = [...directlyAffected, ...relatedContext].slice(0, 5);
  const driftDisplay = allDriftFiles.length > 0 ? `\nRelevant drift: ${allDriftFiles.join(", ")}` : "";
  const affectedDisplay = affectedActionItemIds.length > 0
    ? `\nRecommendations ${affectedActionItemIds.join(", ")} may need revalidation.`
    : "";

  const summaryNote =
    `Adviser reviewed ${graph.checkpoint.slice(0, 7)}. ` +
    `Current HEAD is ${graph.currentHead.slice(0, 7)}, ${graph.commitsAhead} commit${graph.commitsAhead === 1 ? "" : "s"} ahead.` +
    driftDisplay +
    affectedDisplay;

  const recommendedAction = classification === "materially_stale"
    ? "Relevant files have changed. Revalidate affected recommendations against current code."
    : "Checkpoint is an ancestor; advice likely applies. Verify before acting.";

  return {
    classification,
    graphDrift: graph,
    fileDrift,
    summaryNote,
    affectedActionItemIds,
    recommendedAction,
  };
}
