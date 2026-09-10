import { describe, expect, it } from "vitest";

import { resolveModelPreference } from "./model-selection.js";
import type { ModelOption } from "./runtime-types.js";

function model(modelId: string, overrides: Partial<ModelOption> = {}): ModelOption {
  return { modelId, displayName: modelId, available: true, ...overrides };
}

describe("resolveModelPreference", () => {
  it("returns the top preference when it is selectable", () => {
    const result = resolveModelPreference(["gpt-5.5", "gpt-5"], [model("gpt-5.5"), model("gpt-5")]);
    expect(result).toMatchObject({ ok: true, model: { modelId: "gpt-5.5" }, degraded: false });
  });

  it("drops to the next preference and reports the downgrade", () => {
    const result = resolveModelPreference(["gpt-5.6", "gpt-5.5"], [model("gpt-5.5")]);
    expect(result).toMatchObject({ ok: true, model: { modelId: "gpt-5.5" }, degraded: true });
    if (result.ok) expect(result.reason).toContain("gpt-5.6");
  });

  it("skips greyed-out options rather than returning an unclickable model", () => {
    const result = resolveModelPreference(["gpt-5.5"], [model("gpt-5.5", { available: false, unavailableReason: "plan" })]);
    expect(result).toMatchObject({ ok: false, reason: "none-available" });
  });

  it("matches a preference stored as a display label against an id-reporting picker", () => {
    const result = resolveModelPreference(["GPT 5.5"], [{ modelId: "gpt-5.5", displayName: "GPT-5.5", available: true }]);
    expect(result).toMatchObject({ ok: true, model: { modelId: "gpt-5.5" } });
  });

  it("falls back to the strongest selectable model when no preference matches", () => {
    const result = resolveModelPreference(["gpt-9"], [model("gpt-5.5"), model("gpt-5")]);
    expect(result).toMatchObject({ ok: true, model: { modelId: "gpt-5.5" }, degraded: true });
    if (result.ok) expect(result.reason).toContain("no preference");
  });

  it("reports no-models distinctly from none-available", () => {
    expect(resolveModelPreference(["gpt-5.5"], [])).toMatchObject({ ok: false, reason: "no-models" });
    expect(resolveModelPreference([], [model("gpt-5.5")])).toMatchObject({ ok: false, reason: "preference-empty" });
  });
});
