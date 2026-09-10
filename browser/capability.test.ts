import { describe, expect, it } from "vitest";

import {
  capabilityAllowsConsultation,
  classifyCapabilityProbe,
  loadCapabilityState,
  parseCapabilityState,
  serializeCapabilityState,
  type CapabilityObservation,
} from "./capability.js";

const CHECKED_AT = "2026-01-01T00:00:00.000Z";

function classify(observation: CapabilityObservation) {
  return classifyCapabilityProbe(observation, CHECKED_AT);
}

describe("classifyCapabilityProbe", () => {
  it("treats only a signed-in probe as consultation-ready", () => {
    const record = classify({ kind: "signed-in", planHint: "plus" });
    expect(record.status).toBe("ready");
    expect(record.nextAction).toBe("consult");
    expect(record.requiresManualIntervention).toBe(false);
    expect(capabilityAllowsConsultation(record)).toBe(true);
  });

  it("keeps a human challenge distinct from being signed out", () => {
    const challenge = classify({ kind: "human-verification", challenge: "cloudflare" });
    const signedOut = classify({ kind: "signed-out" });
    expect(challenge.status).toBe("manual-intervention-required");
    expect(challenge.nextAction).toBe("solve-verification");
    expect(signedOut.nextAction).toBe("manual-login");
    expect(challenge.status).not.toBe(signedOut.status);
    // Both need a person, and neither is retried automatically.
    expect(challenge.requiresManualIntervention).toBe(true);
    expect(signedOut.requiresManualIntervention).toBe(true);
  });

  it("does not ask a human for a rate limit", () => {
    const record = classify({ kind: "rate-limited", retryAfterSeconds: 90 });
    expect(record.requiresManualIntervention).toBe(false);
    expect(record.retryAfterSeconds).toBe(90);
    expect(record.explanation).toContain("90");
  });

  it("names the unsupported plan and stops", () => {
    const record = classify({ kind: "plan-unsupported", planHint: "free" });
    expect(record.nextAction).toBe("stop-unsupported-plan");
    expect(record.explanation).toContain("free");
  });

  it.each([
    ["browser-not-installed", "Chrome"],
    ["no-display", "display"],
    ["profile-locked", "profile"],
    ["network", "network"],
    ["runtime-error", "runtime"],
  ] as const)("explains %s in terms a user can act on", (reason, keyword) => {
    const record = classify({ kind: "environment-unavailable", reason });
    expect(record.status).toBe("environment-unavailable");
    expect(record.nextAction).toBe("repair-environment");
    expect(record.explanation).toMatch(new RegExp(keyword, "iu"));
  });

  it("never carries runtime detail into the record", () => {
    const record = classify({
      kind: "environment-unavailable",
      reason: "runtime-error",
      detail: "failed at /home/ada/.config/google-chrome with token=abc",
    });
    expect(JSON.stringify(record)).not.toContain("/home/ada");
    expect(JSON.stringify(record)).not.toContain("token=abc");
  });
});

describe("capability state persistence", () => {
  it("round-trips a record", () => {
    const record = classify({ kind: "signed-in", planHint: "pro" });
    const parsed = parseCapabilityState(serializeCapabilityState(record));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toEqual(record);
  });

  it("refuses an unknown schema rather than guessing", () => {
    const parsed = parseCapabilityState(JSON.stringify({ schema: 2, record: {} }));
    expect(!parsed.ok && parsed.failure).toBe("unknown-schema");
  });

  it("refuses a record missing required fields", () => {
    expect(!parseCapabilityState(JSON.stringify({ schema: 1, record: { status: "ready" } })).ok).toBe(true);
    expect(!parseCapabilityState("{").ok).toBe(true);
  });

  it("reports an absent file as absent, not malformed", async () => {
    const loaded = await loadCapabilityState("/nonexistent/capability.json");
    expect(!loaded.ok && loaded.failure).toBe("absent");
  });
});
