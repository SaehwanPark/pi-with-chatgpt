import { describe, expect, it } from "vitest";

import { buildFollowUpBrief, FollowUpValidationError } from "./follow-up.js";
import { CHECKPOINT_SHA, OTHER_CHECKPOINT_SHA } from "../test/fixtures.js";
import type { ConsultationId } from "../protocol/checkpoint.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";

const PREV_ID = "adv-0014" as ConsultationId;
const NEW_ID = "adv-0015" as ConsultationId;
const REPO = canonicalRepositoryKey("owner", "my-project");
const PREV_COMMIT = CHECKPOINT_SHA;
const NEW_COMMIT = OTHER_CHECKPOINT_SHA;

describe("buildFollowUpBrief (M7)", () => {
  it("builds a follow-up brief with previous checkpoint and action item dispositions", () => {
    const brief = buildFollowUpBrief({
      consultationId: NEW_ID,
      previousConsultationId: PREV_ID,
      kind: "audit",
      repository: REPO,
      branch: "feat/ownership",
      previousCheckpoint: PREV_COMMIT,
      newCheckpoint: NEW_COMMIT,
      prNumber: 42,
      priorActionItems: [
        { id: "A1", summary: "Refactor error handler", disposition: "implemented" },
        {
          id: "A2",
          summary: "Remove legacy cache",
          disposition: "rejected_with_reason",
          dispositionNote: "Conflicts with backward compatibility",
        },
      ],
      goal: "Audit remaining concurrency hazards after refactoring error handler",
      concern: "Possibility of race on double shutdown",
      question: "Are any critical hazards still unresolved?",
    });

    expect(brief).toContain("FOLLOW-UP CONSULTATION: adv-0015 (referencing adv-0014)");
    expect(brief).toContain(`PREVIOUS CHECKPOINT: ${PREV_COMMIT}`);
    expect(brief).toContain(`NEW CHECKPOINT: ${NEW_COMMIT}`);
    expect(brief).toContain("PR: #42");
    expect(brief).toContain("- A1 [implemented]: Refactor error handler");
    expect(brief).toContain("- A2 [rejected_with_reason]: Remove legacy cache (Reason: Conflicts with backward compatibility)");
    expect(brief).toContain("GOAL: Audit remaining concurrency hazards after refactoring error handler");
    expect(brief).toContain("CONCERN: Possibility of race on double shutdown");
    expect(brief).toContain("QUESTION: Are any critical hazards still unresolved?");
    expect(brief).toContain("Inspect the new repository state directly through GitHub at NEW CHECKPOINT");
  });

  it("handles empty action items gracefully", () => {
    const brief = buildFollowUpBrief({
      consultationId: NEW_ID,
      previousConsultationId: PREV_ID,
      kind: "plan",
      repository: REPO,
      branch: null,
      previousCheckpoint: PREV_COMMIT,
      newCheckpoint: NEW_COMMIT,
      priorActionItems: [],
      goal: "Follow-up plan",
      question: "Is this complete?",
    });

    expect(brief).toContain("BRANCH: (detached HEAD)");
    expect(brief).toContain("- (None recorded)");
    expect(brief).not.toContain("PR:");
  });

  it("rejects briefs containing credentials (INV-12)", () => {
    expect(() =>
      buildFollowUpBrief({
        consultationId: NEW_ID,
        previousConsultationId: PREV_ID,
        kind: "plan",
        repository: REPO,
        branch: "main",
        previousCheckpoint: PREV_COMMIT,
        newCheckpoint: NEW_COMMIT,
        priorActionItems: [],
        goal: "Use token sk-1234567890123456",
        question: "How to proceed?",
      }),
    ).toThrow(FollowUpValidationError);
  });
});
