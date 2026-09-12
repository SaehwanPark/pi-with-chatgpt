import { describe, expect, it } from "vitest";

import { buildConsultationBrief, BriefValidationError, DEFAULT_BRIEF_INSTRUCTION } from "./brief.js";
import type { ConsultationId } from "./checkpoint.js";
import type { FullCommitSha } from "./sha.js";
import type { GitHubRepositoryKey } from "./repo.js";

const VALID_ID = "adv-0001" as ConsultationId;
const VALID_SHA = "8f731e2890123456789012345678901234567890" as FullCommitSha;
const VALID_REPO = "owner/my-project" as GitHubRepositoryKey;

describe("buildConsultationBrief", () => {
  it("builds a canonical decision brief with all standard fields", () => {
    const brief = buildConsultationBrief({
      consultationId: VALID_ID,
      kind: "audit",
      repository: VALID_REPO,
      branch: "feat/ownership",
      checkpointSha: VALID_SHA,
      prNumber: 42,
      goal: "Implement memory safety audit on session cleanup",
      currentApproach: "Manual delete on disconnect",
      concern: "Potential resource leak when client crashes abruptly",
      question: "What failure modes should we guard against?",
    });

    expect(brief).toContain("CONSULTATION: adv-0001");
    expect(brief).toContain("TYPE: audit");
    expect(brief).toContain("REPOSITORY: owner/my-project");
    expect(brief).toContain("BRANCH: feat/ownership");
    expect(brief).toContain(`CHECKPOINT: ${VALID_SHA}`);
    expect(brief).toContain("PR: #42");
    expect(brief).toContain("GOAL: Implement memory safety audit on session cleanup");
    expect(brief).toContain("CURRENT APPROACH: Manual delete on disconnect");
    expect(brief).toContain("CONCERN: Potential resource leak when client crashes abruptly");
    expect(brief).toContain("QUESTION: What failure modes should we guard against?");
    expect(brief).toContain(`INSTRUCTION: ${DEFAULT_BRIEF_INSTRUCTION}`);
  });

  it("handles detached HEAD cleanly", () => {
    const brief = buildConsultationBrief({
      consultationId: VALID_ID,
      kind: "plan",
      repository: VALID_REPO,
      branch: null,
      checkpointSha: VALID_SHA,
      goal: "Design cache invalidation",
      question: "How should cache keys be scoped?",
    });

    expect(brief).toContain("BRANCH: (detached HEAD)");
    expect(brief).not.toContain("PR:");
    expect(brief).not.toContain("CURRENT APPROACH:");
    expect(brief).not.toContain("CONCERN:");
  });

  it("supports all semantic request types", () => {
    const kinds = ["consult", "plan", "review", "audit", "debug", "challenge"] as const;
    for (const kind of kinds) {
      const brief = buildConsultationBrief({
        consultationId: VALID_ID,
        kind,
        repository: VALID_REPO,
        branch: "main",
        checkpointSha: VALID_SHA,
        goal: "Test kind",
        question: "Is this supported?",
      });
      expect(brief).toContain(`TYPE: ${kind}`);
    }
  });

  it("rejects invalid consultation ID", () => {
    expect(() =>
      buildConsultationBrief({
        consultationId: "invalid-id" as ConsultationId,
        kind: "consult",
        repository: VALID_REPO,
        branch: "main",
        checkpointSha: VALID_SHA,
        goal: "Goal",
        question: "Question",
      }),
    ).toThrow(BriefValidationError);
  });

  it("rejects invalid checkpoint SHA", () => {
    expect(() =>
      buildConsultationBrief({
        consultationId: VALID_ID,
        kind: "consult",
        repository: VALID_REPO,
        branch: "main",
        checkpointSha: "not-a-sha" as FullCommitSha,
        goal: "Goal",
        question: "Question",
      }),
    ).toThrow(BriefValidationError);
  });

  it("rejects empty goal or question", () => {
    expect(() =>
      buildConsultationBrief({
        consultationId: VALID_ID,
        kind: "consult",
        repository: VALID_REPO,
        branch: "main",
        checkpointSha: VALID_SHA,
        goal: "   ",
        question: "Valid question",
      }),
    ).toThrow(BriefValidationError);

    expect(() =>
      buildConsultationBrief({
        consultationId: VALID_ID,
        kind: "consult",
        repository: VALID_REPO,
        branch: "main",
        checkpointSha: VALID_SHA,
        goal: "Valid goal",
        question: "",
      }),
    ).toThrow(BriefValidationError);
  });

  it("rejects secret tokens or keys in brief options (INV-12)", () => {
    expect(() =>
      buildConsultationBrief({
        consultationId: VALID_ID,
        kind: "consult",
        repository: VALID_REPO,
        branch: "main",
        checkpointSha: VALID_SHA,
        goal: "Use my token ghp_12345678901234567890",
        question: "How to authenticate?",
      }),
    ).toThrow(BriefValidationError);
  });

  it("rejects code diff dumps (INV-02)", () => {
    const diffText = "diff --git a/file.ts b/file.ts\nindex 1234567..89abcdef 100644\n--- a/file.ts\n+++ b/file.ts";
    expect(() =>
      buildConsultationBrief({
        consultationId: VALID_ID,
        kind: "review",
        repository: VALID_REPO,
        branch: "main",
        checkpointSha: VALID_SHA,
        goal: "Review diff",
        concern: diffText,
        question: "Does this look good?",
      }),
    ).toThrow(BriefValidationError);
  });
});
