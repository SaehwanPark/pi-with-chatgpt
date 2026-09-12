/**
 * Follow-up consultation brief builder (INV-01, INV-02, INV-03, INV-05).
 *
 * Implements follow-up briefs for `/advisor-followup`:
 * - References previous consultation ID and original reviewed checkpoint.
 * - Anchors to the new full commit SHA.
 * - Summarizes prior action items and their recorded dispositions.
 * - Directs ChatGPT to inspect the new GitHub state rather than trust prose.
 */

import { isConsultationId, type ConsultationId } from "../protocol/checkpoint.js";
import { isFullCommitSha, type FullCommitSha } from "../protocol/sha.js";
import type { GitHubRepositoryKey } from "../protocol/repo.js";
import { isConsultationKind, type ConsultationKind } from "../protocol/brief.js";
import { containsSensitiveData } from "../protocol/masking.js";
import type { ActionItemDisposition } from "../ledger/ledger.js";

export const DEFAULT_FOLLOW_UP_INSTRUCTION =
  "Inspect the new repository state directly through GitHub at NEW CHECKPOINT. " +
  "Do not rely on prose claims or assume previous code remained unchanged. " +
  "Do not implement anything. Do not ask for pasted or uploaded files. " +
  "Provide reasoning and updated actionable recommendations.";

export interface PriorActionItemSummary {
  readonly id: string;
  readonly summary: string;
  readonly disposition?: ActionItemDisposition;
  readonly dispositionNote?: string;
}

export interface FollowUpBriefOptions {
  readonly consultationId: ConsultationId;
  readonly previousConsultationId: ConsultationId;
  readonly kind: ConsultationKind;
  readonly repository: GitHubRepositoryKey;
  readonly branch: string | null;
  readonly previousCheckpoint: FullCommitSha;
  readonly newCheckpoint: FullCommitSha;
  readonly prNumber?: number;
  readonly priorActionItems: readonly PriorActionItemSummary[];
  readonly goal: string;
  readonly concern?: string;
  readonly question: string;
}

export class FollowUpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowUpValidationError";
  }
}

/**
 * Builds a structured follow-up decision brief.
 */
export function buildFollowUpBrief(options: FollowUpBriefOptions): string {
  if (!isConsultationId(options.consultationId)) {
    throw new FollowUpValidationError(`Invalid consultation ID: "${options.consultationId as string}"`);
  }
  if (!isConsultationId(options.previousConsultationId)) {
    throw new FollowUpValidationError(`Invalid previous consultation ID: "${options.previousConsultationId as string}"`);
  }
  if (!isConsultationKind(options.kind)) {
    throw new FollowUpValidationError(`Invalid consultation kind: "${options.kind as string}"`);
  }
  if (!isFullCommitSha(options.previousCheckpoint)) {
    throw new FollowUpValidationError(`Invalid previous checkpoint SHA: "${options.previousCheckpoint as string}"`);
  }
  if (!isFullCommitSha(options.newCheckpoint)) {
    throw new FollowUpValidationError(`Invalid new checkpoint SHA: "${options.newCheckpoint as string}"`);
  }

  const goal = options.goal.trim();
  if (goal.length === 0) {
    throw new FollowUpValidationError("Goal cannot be empty.");
  }

  const question = options.question.trim();
  if (question.length === 0) {
    throw new FollowUpValidationError("Question cannot be empty.");
  }

  if (containsSensitiveData(options)) {
    throw new FollowUpValidationError(
      "Refusing to build follow-up brief: contains secret credentials or sensitive tokens (INV-12)",
    );
  }

  const branchDisplay = options.branch && options.branch.trim().length > 0
    ? options.branch.trim()
    : "(detached HEAD)";

  const lines: string[] = [
    `FOLLOW-UP CONSULTATION: ${options.consultationId} (referencing ${options.previousConsultationId})`,
    `TYPE: ${options.kind}`,
    `REPOSITORY: ${options.repository}`,
    `BRANCH: ${branchDisplay}`,
    `PREVIOUS CHECKPOINT: ${options.previousCheckpoint}`,
    `NEW CHECKPOINT: ${options.newCheckpoint}`,
  ];

  if (options.prNumber !== undefined && Number.isInteger(options.prNumber) && options.prNumber > 0) {
    lines.push(`PR: #${options.prNumber}`);
  }

  lines.push("");
  lines.push("PREVIOUS ACTION ITEMS & DISPOSITIONS:");
  if (options.priorActionItems.length === 0) {
    lines.push("- (None recorded)");
  } else {
    for (const item of options.priorActionItems) {
      const disp = item.disposition ?? "pending";
      const note = item.dispositionNote ? ` (Reason: ${item.dispositionNote})` : "";
      lines.push(`- ${item.id} [${disp}]: ${item.summary}${note}`);
    }
  }

  lines.push("");
  lines.push(`GOAL: ${goal}`);

  if (options.concern && options.concern.trim().length > 0) {
    lines.push(`CONCERN: ${options.concern.trim()}`);
  }

  lines.push(`QUESTION: ${question}`);
  lines.push("");
  lines.push(`INSTRUCTION: ${DEFAULT_FOLLOW_UP_INSTRUCTION}`);

  return lines.join("\n");
}
