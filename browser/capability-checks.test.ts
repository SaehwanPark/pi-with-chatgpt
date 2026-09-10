import { describe, expect, it } from "vitest";

import type { CapabilityRecord } from "./capability.js";
import {
  capabilityCacheIsValid,
  checklistToCapabilityRecord,
  evaluateConsultationPrerequisites,
  REQUIRED_BEFORE_FIRST_CONSULTATION,
  selectAdviserModel,
  type CapabilityChecklist,
  type VerificationResult,
} from "./capability-checks.js";

const NOW = "2026-01-01T12:00:00.000Z";

function checklist(results: readonly VerificationResult[]): CapabilityChecklist {
  return { results, checkedAt: NOW };
}

const ALL_GOOD: readonly VerificationResult[] = [
  { item: "chatgpt-access", outcome: "verified" },
  { item: "adviser-model", outcome: "verified" },
  { item: "github-connector", outcome: "verified" },
  { item: "target-repository", outcome: "verified" },
];

describe("evaluateConsultationPrerequisites", () => {
  it("passes when every required item is verified", () => {
    const result = evaluateConsultationPrerequisites(checklist(ALL_GOOD));
    expect(result.ok).toBe(true);
  });

  it("treats an unrun check as blocking, and says so distinctly", () => {
    const result = evaluateConsultationPrerequisites(
      checklist(ALL_GOOD.map((entry) => (entry.item === "target-repository" ? { ...entry, outcome: "unverified" } : entry))),
    );
    expect(!result.ok && result.blocking).toEqual([{ item: "target-repository", outcome: "unverified" }]);
  });

  it("blocks on an unavailable checkpoint rather than dispatching", () => {
    const result = evaluateConsultationPrerequisites(
      checklist(ALL_GOOD.map((entry) => (entry.item === "target-repository" ? { ...entry, outcome: "unavailable" } : entry))),
    );
    expect(!result.ok && result.blocking[0]?.outcome).toBe("unavailable");
  });

  it("does not block a consultation on an unverified GitHub connector", () => {
    // The connector only widens what the adviser can see; its absence degrades the answer, not the run.
    const result = evaluateConsultationPrerequisites(
      checklist(ALL_GOOD.map((entry) => (entry.item === "github-connector" ? { ...entry, outcome: "unverified" } : entry))),
    );
    expect(result.ok).toBe(true);
  });

  it("lists every blocker at once so a human fixes them in one pass", () => {
    const result = evaluateConsultationPrerequisites(
      checklist([
        { item: "chatgpt-access", outcome: "unverified" },
        { item: "adviser-model", outcome: "unavailable" },
        { item: "target-repository", outcome: "unverified" },
      ]),
    );
    expect(!result.ok && result.blocking.map((entry) => entry.item)).toEqual([
      "chatgpt-access",
      "adviser-model",
      "target-repository",
    ]);
  });

  it("requires exactly the documented set", () => {
    expect(REQUIRED_BEFORE_FIRST_CONSULTATION).toEqual(["chatgpt-access", "adviser-model", "target-repository"]);
  });
});

describe("selectAdviserModel", () => {
  it("uses the requested model when it is offered", () => {
    expect(selectAdviserModel("gpt-5-pro", ["gpt-5-pro", "gpt-5"])).toEqual({ model: "gpt-5-pro", degraded: false });
  });

  it("falls back to the best available equivalent and marks it degraded", () => {
    expect(selectAdviserModel("gpt-5-pro", ["gpt-5", "gpt-5-mini"], ["gpt-5-pro", "gpt-5", "gpt-5-mini"])).toEqual({
      model: "gpt-5",
      degraded: true,
    });
  });

  it("never invents a model the provider does not offer", () => {
    expect(selectAdviserModel("gpt-5-pro", ["gpt-5-mini"], ["gpt-5-pro", "gpt-5"])).toEqual({
      model: undefined,
      degraded: true,
    });
    expect(selectAdviserModel("gpt-5-pro", [])).toEqual({ model: undefined, degraded: true });
  });
});

describe("capabilityCacheIsValid", () => {
  function record(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
    return {
      status: "ready",
      checkedAt: NOW,
      explanation: "ok",
      requiresManualIntervention: false,
      nextAction: "consult",
      ...overrides,
    };
  }

  it("accepts a recent positive result", () => {
    expect(capabilityCacheIsValid(record(), { now: "2026-01-01T13:00:00.000Z" })).toBe(true);
  });

  it("expires a positive result instead of trusting it forever", () => {
    expect(capabilityCacheIsValid(record(), { now: "2026-01-02T12:00:00.000Z" })).toBe(false);
  });

  it("expires a negative result faster than a positive one", () => {
    const negative = record({ status: "environment-unavailable", nextAction: "repair-environment" });
    expect(capabilityCacheIsValid(negative, { now: "2026-01-01T12:06:00.000Z" })).toBe(false);
    expect(capabilityCacheIsValid(record(), { now: "2026-01-01T12:06:00.000Z" })).toBe(true);
  });

  it("invalidates on any revalidating event regardless of age", () => {
    // The failure this prevents: a hours-old "ready" surviving a sign-out.
    for (const event of ["sign-in-completed", "chrome-state-imported", "authentication-failed"] as const) {
      expect(capabilityCacheIsValid(record(), { now: "2026-01-01T12:00:01.000Z", event })).toBe(false);
    }
  });

  it("never caches a stated retry window", () => {
    // A rate limit is re-probed after the wait, never remembered as still-limited.
    const limited = record({ status: "rate-limited", retryAfterSeconds: 120, nextAction: "wait-for-rate-limit" });
    expect(capabilityCacheIsValid(limited, { now: "2026-01-01T12:01:00.000Z" })).toBe(false);
    expect(capabilityCacheIsValid(limited, { now: "2026-01-01T12:03:00.000Z" })).toBe(false);
  });

  it("rejects an unparseable or future timestamp", () => {
    expect(capabilityCacheIsValid(record(), { now: "later" })).toBe(false);
    expect(capabilityCacheIsValid(record({ checkedAt: "2026-01-02T00:00:00.000Z" }), { now: NOW })).toBe(false);
  });
});

describe("checklistToCapabilityRecord", () => {
  it("maps a green checklist to a consultation", () => {
    const record = checklistToCapabilityRecord(
      checklist(ALL_GOOD),
      evaluateConsultationPrerequisites(checklist(ALL_GOOD)),
    );
    expect(record.status).toBe("ready");
    expect(record.nextAction).toBe("consult");
  });

  it("maps a missing checkpoint to publishing it, never to pushing silently", () => {
    const list = checklist(
      ALL_GOOD.map((entry) => (entry.item === "target-repository" ? { ...entry, outcome: "unavailable" } : entry)),
    );
    const record = checklistToCapabilityRecord(list, evaluateConsultationPrerequisites(list));
    expect(record.nextAction).toBe("publish-checkpoint");
    expect(record.requiresManualIntervention).toBe(true);
  });

  it("maps an unavailable model to an explicit model choice", () => {
    const list = checklist(
      ALL_GOOD.map((entry) => (entry.item === "adviser-model" ? { ...entry, outcome: "unavailable" } : entry)),
    );
    expect(checklistToCapabilityRecord(list, evaluateConsultationPrerequisites(list)).nextAction).toBe(
      "choose-adviser-model",
    );
  });

  it("keeps an unverified access check a sign-in question, not an environment failure", () => {
    const list = checklist(ALL_GOOD.map((entry) => ({ ...entry, outcome: "unverified" as const })));
    const record = checklistToCapabilityRecord(list, evaluateConsultationPrerequisites(list));
    expect(record.status).toBe("sign-in-required");
    expect(record.nextAction).toBe("manual-login");
    expect(record.requiresManualIntervention).toBe(true);
    expect(record.reason).toBe("chatgpt-access:unverified");
  });
});
