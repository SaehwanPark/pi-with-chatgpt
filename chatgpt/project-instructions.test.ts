import { describe, expect, it } from "vitest";

import { canonicalRepositoryKey } from "../protocol/repo.js";
import {
  PROJECT_INSTRUCTION_RULES,
  assertProjectInstructionsAreEphemeralFree,
  buildProjectInstructions,
  findEphemeralValues,
  projectTitleForRepository,
} from "./project-instructions.js";

const REPOSITORY = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");

describe("Project instructions (INV-08, INV-14)", () => {
  it("titles the Project from the repository alone", () => {
    // The title is the adoption key under concurrency; if it ever contained a branch or a session it
    // would stop matching and every Pi run would create another Project.
    expect(projectTitleForRepository(REPOSITORY)).toBe("pi-with-chatgpt: saehwanpark/pi-with-chatgpt");
  });

  it("states every required V1 rule", () => {
    const text = buildProjectInstructions({ repository: REPOSITORY });
    expect(text).toContain("Pi (the coding agent) decides and executes");
    expect(text).toContain("bound to exactly one GitHub repository");
    expect(text).toContain("commit SHA in each request is authoritative");
    expect(text).toContain("through the GitHub connector");
    expect(text).toContain("Never ask Pi to paste, upload, or attach");
    expect(text).toContain("lower priority than the code at the checkpoint");
    expect(text).toContain("Development may advance while you are reasoning");
    expect(text).toContain(REPOSITORY);
    expect(PROJECT_INSTRUCTION_RULES.length).toBeGreaterThanOrEqual(8);
  });

  it("carries no branch, SHA, or task value", () => {
    const text = buildProjectInstructions({ repository: REPOSITORY });
    expect(findEphemeralValues(text)).toEqual([]);
    expect(() => assertProjectInstructionsAreEphemeralFree(text)).not.toThrow();
  });

  it("rejects instructions that quote a commit or a ref", () => {
    // The assertion is also applied at the Project-mapping boundary, so a future caller cannot add a free
    // standing-instruction field that silently outranks the checkpoint (INV-14).
    const sha = "0f2c8f4a1d6b4f1e9c2d8e6a5b4c3d2e1f0a9b8c";
    const violations = findEphemeralValues(
      `start from ${sha} please`,
    );
    expect(violations.map((violation) => violation.label)).toContain("full commit SHA");
    expect(() =>
      assertProjectInstructionsAreEphemeralFree(`Use origin/main for the review.\nPR #42 is the context.`),
    ).toThrow(/INV-14/u);
  });
});
