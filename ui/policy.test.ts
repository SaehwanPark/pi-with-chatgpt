import { describe, expect, it } from "vitest";
import { evaluateAutoConsultation } from "./policy.js";

describe("ui/policy (M8)", () => {
  it("returns shouldConsult: false when policy is off", () => {
    const result = evaluateAutoConsultation(
      { goal: "Redesign authentication security architecture" },
      "off",
    );
    expect(result.shouldConsult).toBe(false);
    expect(result.reason).toContain("policy is off");
  });

  it("returns shouldConsult: true when policy is always", () => {
    const result = evaluateAutoConsultation(
      { goal: "Fix typo in comment" },
      "always",
    );
    expect(result.shouldConsult).toBe(true);
    expect(result.reason).toContain("policy set to always");
    expect(result.suggestedKind).toBe("consult");
  });

  it("suppresses trivial edits under high-value policy", () => {
    const result = evaluateAutoConsultation(
      { goal: "Fix typo in README and format whitespace", changedLoc: 500 },
      "high-value",
    );
    expect(result.shouldConsult).toBe(false);
    expect(result.reason).toContain("suppressed: goal indicates trivial");
  });

  it("suppresses simple retry loops without semantic triggers", () => {
    const result = evaluateAutoConsultation(
      { goal: "Run unit test suite again", isRetry: true, failureCount: 2 },
      "high-value",
    );
    expect(result.shouldConsult).toBe(false);
    expect(result.reason).toContain("retry count alone does not meet");
  });

  it("triggers for architecture change", () => {
    const result = evaluateAutoConsultation(
      { goal: "Evaluate architectural module boundaries between runtime and parser" },
      "high-value",
    );
    expect(result.shouldConsult).toBe(true);
    expect(result.suggestedKind).toBe("challenge");
    expect(result.reason).toContain("architectural shift");
  });

  it("triggers for security and auth changes", () => {
    const result = evaluateAutoConsultation(
      { goal: "Audit credential storage and auth cookie containment" },
      "high-value",
    );
    expect(result.shouldConsult).toBe(true);
    expect(result.suggestedKind).toBe("audit");
  });

  it("triggers when change spans 3 or more root modules", () => {
    const result = evaluateAutoConsultation(
      {
        goal: "Update shared utilities across repo",
        modifiedFiles: ["git/exec.ts", "browser/driver.ts", "jobs/engine.ts", "protocol/brief.ts"],
      },
      "high-value",
    );
    expect(result.shouldConsult).toBe(true);
    expect(result.suggestedKind).toBe("plan");
    expect(result.reason).toContain("spans multiple module roots");
  });
});
