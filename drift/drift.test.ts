import { describe, expect, it } from "vitest";

import { adviceCurrencyFor, DRIFT_VERDICTS } from "./index.js";

describe("advice currency (development cursor vs advice cursor)", () => {
  it("covers every verdict without a fallback branch", () => {
    expect(DRIFT_VERDICTS).toEqual([
      "equal",
      "checkpoint-is-ancestor",
      "checkpoint-is-descendant",
      "diverged",
      "unreachable",
    ]);
  });

  it("calls only the identical checkpoint current", () => {
    expect(adviceCurrencyFor("equal")).toBe("current");
  });

  it("marks ancestor advice possibly stale, never wrong", () => {
    expect(adviceCurrencyFor("checkpoint-is-ancestor")).toBe("possibly-stale");
  });

  it.each(["checkpoint-is-descendant", "diverged", "unreachable"] as const)(
    "marks %s advice unreliable",
    (verdict) => {
      expect(adviceCurrencyFor(verdict)).toBe("unreliable");
    },
  );
});
