/**
 * Consultation request briefs (INV-02, INV-03, INV-04).
 *
 * The brief is the only text sent to ChatGPT when initiating a consultation turn.
 * It strictly adheres to the GitHub-only context model:
 *
 * - Includes consultation ID, kind, repository, branch, full checkpoint SHA, optional PR,
 *   goal, current approach, concern, and question.
 * - Explicitly directs the adviser to inspect GitHub directly for the codebase state.
 * - Explicitly tells the adviser not to implement code and not to request uploaded files.
 * - Rejects briefs containing secret credentials, code diffs, or raw code listings.
 */

import { isConsultationId, type ConsultationId } from "./checkpoint.js";
import { isFullCommitSha, type FullCommitSha } from "./sha.js";
import { type GitHubRepositoryKey } from "./repo.js";
import { containsSensitiveData } from "./masking.js";

export const CONSULTATION_KINDS = ["consult", "plan", "review", "audit", "debug", "challenge"] as const;
export type ConsultationKind = (typeof CONSULTATION_KINDS)[number];

export function isConsultationKind(value: string): value is ConsultationKind {
  return (CONSULTATION_KINDS as readonly string[]).includes(value);
}

export const DEFAULT_BRIEF_INSTRUCTION =
  "Inspect the repository yourself through GitHub. Treat CHECKPOINT as the authoritative " +
  "repository state. Do not implement anything. Do not ask for pasted or uploaded files. " +
  "Development may advance while you reason. Provide reasoning and actionable recommendations.";

export interface BuildBriefOptions {
  readonly consultationId: ConsultationId;
  readonly kind: ConsultationKind;
  readonly repository: GitHubRepositoryKey;
  /** Branch name, or `null` for detached HEAD. */
  readonly branch: string | null;
  readonly checkpointSha: FullCommitSha;
  readonly prNumber?: number;
  readonly goal: string;
  readonly currentApproach?: string;
  readonly concern?: string;
  readonly question: string;
  /** Optional override or addition to the instruction text. */
  readonly customInstruction?: string;
}

/** Error thrown when a decision brief violates invariants. */
export class BriefValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefValidationError";
  }
}

/** Patterns that indicate someone is trying to dump source code or diffs into the brief (INV-02). */
const CODE_DUMP_PATTERNS: readonly RegExp[] = [
  /^diff --git /m,
  /^index [0-9a-f]{7,}\.\.[0-9a-f]{7,}/m,
  /^@@ -[0-9]+,[0-9]+ \+[0-9]+,[0-9]+ @@/m,
  /```(?:ts|typescript|js|javascript|json|python|rust|go|c|cpp|html|css)\b[\s\S]{500,}```/u,
];

/**
 * Validates and constructs a canonical decision brief to send to ChatGPT.
 */
export function buildConsultationBrief(options: BuildBriefOptions): string {
  if (!isConsultationId(options.consultationId)) {
    throw new BriefValidationError(`Invalid consultation ID: "${options.consultationId as string}"`);
  }
  if (!isConsultationKind(options.kind)) {
    throw new BriefValidationError(`Invalid consultation kind: "${options.kind as string}"`);
  }
  if (!isFullCommitSha(options.checkpointSha)) {
    throw new BriefValidationError(`Invalid full checkpoint SHA: "${options.checkpointSha as string}"`);
  }

  const goal = options.goal.trim();
  if (goal.length === 0) {
    throw new BriefValidationError("Consultation goal cannot be empty");
  }

  const question = options.question.trim();
  if (question.length === 0) {
    throw new BriefValidationError("Consultation question cannot be empty");
  }

  // Ensure no credentials leaked in brief options (INV-12)
  if (containsSensitiveData(options)) {
    throw new BriefValidationError("Refusing to build brief: contains secret credentials or sensitive tokens (INV-12)");
  }

  // Check for prohibited code / diff dumps
  const textPayloads = [goal, question, options.currentApproach ?? "", options.concern ?? ""];
  for (const text of textPayloads) {
    for (const pattern of CODE_DUMP_PATTERNS) {
      if (pattern.test(text)) {
        throw new BriefValidationError(
          "Brief appears to contain raw code diffs or large code listings (INV-02). " +
          "GitHub is the sole context channel; let the adviser inspect GitHub directly.",
        );
      }
    }
  }

  const branchDisplay = options.branch && options.branch.trim().length > 0
    ? options.branch.trim()
    : "(detached HEAD)";

  const lines: string[] = [
    `CONSULTATION: ${options.consultationId}`,
    `TYPE: ${options.kind}`,
    `REPOSITORY: ${options.repository}`,
    `BRANCH: ${branchDisplay}`,
    `CHECKPOINT: ${options.checkpointSha}`,
  ];

  if (options.prNumber !== undefined && Number.isInteger(options.prNumber) && options.prNumber > 0) {
    lines.push(`PR: #${options.prNumber}`);
  }

  lines.push("");
  lines.push(`GOAL: ${goal}`);

  if (options.currentApproach && options.currentApproach.trim().length > 0) {
    lines.push(`CURRENT APPROACH: ${options.currentApproach.trim()}`);
  }

  if (options.concern && options.concern.trim().length > 0) {
    lines.push(`CONCERN: ${options.concern.trim()}`);
  }

  lines.push(`QUESTION: ${question}`);
  lines.push("");

  const instruction = options.customInstruction
    ? `${DEFAULT_BRIEF_INSTRUCTION} ${options.customInstruction.trim()}`
    : DEFAULT_BRIEF_INSTRUCTION;

  lines.push(`INSTRUCTION: ${instruction}`);

  return lines.join("\n");
}
