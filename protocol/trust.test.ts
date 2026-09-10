import { describe, expect, it } from "vitest";

import {
  approveSuggestion,
  assertNotAdviserAuthored,
  NotAuthorizedError,
  type AdviserActionSuggestion,
  type AdviserResponse,
  type AdviserText,
  type WorkerDecision,
} from "./trust.js";
import { requireFullCommitSha } from "./sha.js";

const advice = (text: string): AdviserText => text as AdviserText;

const suggestion: AdviserActionSuggestion = {
  ordinal: 1,
  summary: advice("add a regression test for the drift case"),
  confidence: "medium",
};

const workerDecision = { author: "worker" } as unknown as WorkerDecision;

describe("adviser output is untrusted input (INV-01, INV-05)", () => {
  it("gives adviser suggestions no executable surface at all", () => {
    // The type has no command/tool/path/script field; the key scan keeps that true even if someone
    // adds a plausible-looking field such as `suggestedCommand`.
    const populated: AdviserActionSuggestion = {
      ordinal: 1,
      summary: advice("x"),
      rationale: advice("y"),
      confidence: "high",
      verificationHint: advice("z"),
    };
    expect(Object.keys(populated).sort()).toEqual(["confidence", "ordinal", "rationale", "summary", "verificationHint"]);
    for (const forbidden of ["command", "argv", "script", "tool", "toolName", "path", "url", "shell"]) {
      expect(populated).not.toHaveProperty(forbidden);
    }
  });

  it("promotes a suggestion only through an authored decision", () => {
    const approved = approveSuggestion(workerDecision, suggestion);
    expect(approved.suggestionOrdinal).toBe(1);
    expect(approved.summary).toBe(suggestion.summary);
    expect(() => assertNotAdviserAuthored(approved.decision)).not.toThrow();
  });

  it("refuses authority claims that come from the adviser", () => {
    expect(() => assertNotAdviserAuthored({ author: "adviser" })).toThrow(NotAuthorizedError);
    expect(() => assertNotAdviserAuthored({ author: "unknown" })).toThrow(NotAuthorizedError);
    expect(() => assertNotAdviserAuthored({} as { author: string })).toThrow(NotAuthorizedError);
  });

  it("records which commit the advice was about", () => {
    const response: AdviserResponse = {
      consultationId: "adv-4f2a-1",
      sourceCommit: requireFullCommitSha("0f2c8f4a1d6b4f1e9c2d8e6a5b4c3d2e1f0a9b8c"),
      answer: advice("the checkpoint resolution looks correct"),
      caveats: [advice("did not see the uncommitted working tree")],
      suggestions: [suggestion],
      observedAt: "2026-09-09T12:00:00.000Z",
    };
    expect(response.sourceCommit).toHaveLength(40);
    // A response is data: nothing on it can be awaited, executed, or pushed.
    expect(Object.values(response).some((value) => typeof value === "function")).toBe(false);
  });
});
