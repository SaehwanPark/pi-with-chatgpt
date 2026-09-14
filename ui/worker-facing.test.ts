import { describe, expect, it } from "vitest";

import { isWorkerFacingKey, toWorkerFacingAdvisory, WORKER_FACING_FORBIDDEN_KEY_PATTERN } from "./worker-facing.js";
import { adviceCurrencyFor } from "../drift/index.js";
import { ledgerRecord } from "../test/fixtures.js";
import type { LedgerEntry } from "../ledger/ledger.js";

describe("worker-facing advice surface (INV-13)", () => {
  it("exposes advice, provenance, and open decisions — nothing else", () => {
    const record = ledgerRecord({ kind: "plan" });
    const advisory = toWorkerFacingAdvisory(record, {
      drift: { verdict: "checkpoint-is-ancestor", currency: adviceCurrencyFor("checkpoint-is-ancestor") },
    });
    expect(Object.keys(advisory).sort()).toEqual([
      "actionItems",
      "advice",
      "checkpoint",
      "consultationId",
      "dependency",
      "drift",
      "kind",
      "state",
    ]);
    expect(advisory.advice).toBe(record.adviserAnswer);
    expect(advisory.checkpoint).toEqual({ requestedRef: "HEAD", resolvedCommit: record.resolvedCommit });
  });

  it("omits absent optional sections instead of emitting empty ones", () => {
    const minimal = toWorkerFacingAdvisory(ledgerRecord({ adviserAnswer: undefined }));
    expect(Object.keys(minimal)).not.toContain("advice");
    expect(Object.keys(minimal)).not.toContain("drift");
  });

  it("suppresses incomplete responses and their action items", () => {
    const record: LedgerEntry = {
      schemaVersion: 1,
      consultationId: "adv-incomplete-1" as LedgerEntry["consultationId"],
      taskId: "task-incomplete",
      repository: ledgerRecord().repository,
      branch: "main",
      requestedRef: "HEAD",
      resolvedCommit: ledgerRecord().resolvedCommit,
      headAtDispatch: ledgerRecord().resolvedCommit,
      kind: "review",
      dependency: "advisory",
      projectId: "project-1",
      conversationId: "conversation-1",
      status: "completed",
      resultStatus: "incomplete",
      adviserAnswer: "partial recommendation that must not be acted on",
      actionItems: [{ id: "A1", summary: "unsafe partial action", disposition: "pending" }],
      createdAt: "2026-09-09T12:00:00.000Z",
      completedAt: "2026-09-09T12:00:31.000Z",
    };
    const advisory = toWorkerFacingAdvisory(record);
    expect(advisory.resultStatus).toBe("incomplete");
    expect(advisory.advice).toBeUndefined();
    expect(advisory.actionItems).toEqual([]);
    expect(advisory.degradation?.nextStep).toContain("Continue locally");
  });

  it("reports adviser failure as a next step, not as browser internals", () => {
    const degraded = toWorkerFacingAdvisory(ledgerRecord({ state: "failed", adviserAnswer: undefined }), {
      degradation: { reason: "adviser-unavailable", nextStep: "continue locally; advice is optional here" },
    });
    expect(degraded.degradation?.nextStep).toContain("continue locally");
  });

  it("never surfaces machinery keys", () => {
    for (const forbidden of [
      "dom",
      "selector",
      "conversationUrl",
      "projectUrl",
      "userDataDir",
      "cookieHeader",
      "oauthToken",
      "rawResponse",
      "pollState",
      "screenshotPath",
    ]) {
      expect(isWorkerFacingKey(forbidden), forbidden).toBe(false);
    }
    for (const key of ["advice", "checkpoint", "drift", "actionItems", "degradation"]) {
      expect(isWorkerFacingKey(key), key).toBe(true);
    }
    // The forbidden pattern must stay a superset of the keys the advisory type can produce.
    const advisory = toWorkerFacingAdvisory(ledgerRecord());
    for (const key of [...Object.keys(advisory), ...Object.keys(advisory.checkpoint)]) {
      expect(key).not.toMatch(WORKER_FACING_FORBIDDEN_KEY_PATTERN);
    }
  });
});
