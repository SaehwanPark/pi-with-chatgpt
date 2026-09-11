/**
 * ChatGPT Project instructions (INV-08, INV-14).
 *
 * Project instructions are the only standing text the adviser reads, and they are the one place where the
 * V1 contract can be restated every time a conversation starts. What must never appear in them is a
 * *value* that changes: a branch name, a commit SHA, a PR number, a task id. Embedding those turns the
 * Project into a stale source of truth that outranks the checkpoint the consultation is anchored to,
 * which is exactly the trust-order violation INV-14 forbids. Ephemeral values belong in the request
 * brief (M6), which is regenerated per consultation.
 *
 * Style constraint: concise. Long instructions crowd out the actual question, so each rule is one line.
 */

import type { GitHubRepositoryKey } from "../protocol/repo.js";

export interface ProjectInstructionsInput {
  readonly repository: GitHubRepositoryKey;
}

/** A Project is per repository, so the title is derived from the repository and nothing else (INV-08). */
export function projectTitleForRepository(repository: GitHubRepositoryKey): string {
  return `pi-with-chatgpt: ${repository}`;
}

export const PROJECT_INSTRUCTION_RULES = [
  "This Project is bound to exactly one GitHub repository and to no other source of code.",
  "Pi (the coding agent) decides and executes; ChatGPT advises. Never run commands, edit files, commit, or push.",
  "The commit SHA in each request is authoritative: review that exact state, not a branch and not the latest commit.",
  "Inspect the repository yourself through the GitHub connector; that is the only code channel in V1.",
  "Never ask Pi to paste, upload, or attach repository files, logs, screenshots, or archives.",
  "Project instructions and Project memory are lower priority than the code at the checkpoint under review.",
  "Development may advance while you are reasoning; state which claims depend on the checkpoint staying current.",
  "Answer with reasoning plus actionable, independently checkable recommendations.",
] as const;

export const PROJECT_INSTRUCTION_HEADER = "pi-with-chatgpt adviser Project";

/**
 * Compose the instruction text.
 *
 * The repository is the one mutable-looking value that *is* allowed: the mapping is one-Project-per-
 * repository, so the canonical `owner/repo` cannot go stale without the Project itself becoming invalid.
 */
export function buildProjectInstructions(input: ProjectInstructionsInput): string {
  const lines = [
    PROJECT_INSTRUCTION_HEADER,
    `Repository: ${input.repository}`,
    "",
    ...PROJECT_INSTRUCTION_RULES.map((rule, index) => `${index + 1}. ${rule}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** Anything shaped like a checkpoint or a ref in standing instructions is an INV-14 violation. */
const EPHEMERAL_VALUE_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "full commit SHA", pattern: /\b[0-9a-f]{40}\b/u },
  { label: "short commit SHA", pattern: /\b[0-9a-f]{7,12}\b(?!\s*(?:%|\/|\)))/u },
  { label: "git ref name", pattern: /\b(?:refs\/(?:heads|tags)\/|origin\/|HEAD\b)/iu },
  { label: "pull request reference", pattern: /\bPR\s*#?\d+\b|\B#\d+\b/u },
];

export type EphemeralValueViolation = { readonly label: string; readonly excerpt: string };

/**
 * Prove the instructions carry no ephemeral values.
 *
 * Runs over the complete text passed to the surface, so a future caller cannot slip a second, stale
 * provenance claim into every consultation.
 */
export function findEphemeralValues(text: string): readonly EphemeralValueViolation[] {
  const violations: EphemeralValueViolation[] = [];
  for (const line of text.split("\n")) {
    for (const { label, pattern } of EPHEMERAL_VALUE_PATTERNS) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const start = Math.max(match.index - 12, 0);
      violations.push({ label, excerpt: line.slice(start, match.index + match[0].length + 12).trim() });
    }
  }
  return violations;
}

/** Refuse to send instructions that would put the Project above the checkpoint. */
export function assertProjectInstructionsAreEphemeralFree(text: string): void {
  const violations = findEphemeralValues(text);
  if (violations.length > 0) {
    const first = violations[0] as EphemeralValueViolation;
    throw new Error(
      `Project instructions must not embed mutable repository state (found ${first.label}: "${first.excerpt}"); put checkpoint values in the request brief instead (INV-14).`,
    );
  }
}
