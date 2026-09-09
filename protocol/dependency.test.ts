import { describe, expect, it } from "vitest";

import {
  adviserFailureOutcome,
  DEFAULT_DEPENDENCY_MODE,
  DEPENDENCY_MODES,
  dispositionFor,
  normalizeDependencyMode,
} from "./dependency.js";

describe("advisory failure is non-blocking (INV-07)", () => {
  it("defaults to advisory", () => {
    expect(DEPENDENCY_MODES).toEqual(["advisory", "required"]);
    expect(DEFAULT_DEPENDENCY_MODE).toBe("advisory");
    expect(normalizeDependencyMode(undefined)).toBe("advisory");
    expect(normalizeDependencyMode("nonsense")).toBe("advisory");
  });

  it("degrades to local work when an advisory consultation fails", () => {
    expect(dispositionFor("advisory")).toBe("degrade-to-local");
    const outcome = adviserFailureOutcome("advisory", "browser-runtime-failed");
    expect(outcome.kind).toBe("adviser-failed");
    if (outcome.kind !== "adviser-failed") throw new Error("expected advisory degradation");
    expect(outcome.disposition).toBe("degrade-to-local");
  });

  it("blocks only when the caller explicitly required the adviser", () => {
    const outcome = adviserFailureOutcome("required", "timeout");
    expect(outcome.kind).toBe("blocked-on-adviser");
    if (outcome.kind !== "blocked-on-adviser") throw new Error("expected blocking");
    expect(outcome.mode).toBe("required");
    expect(outcome.disposition).toBe("block-local-work");
  });
});
