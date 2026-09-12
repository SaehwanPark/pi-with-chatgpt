import { describe, expect, it } from "vitest";
import {
  formatDispatchStatus,
  formatCompletionNotification,
  formatFullAdvisoryView,
} from "./tui.js";
import { CHECKPOINT_SHA } from "../test/fixtures.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import type { ConsultationId } from "../protocol/checkpoint.js";

describe("ui/tui (M8)", () => {
  it("formats compact dispatch status line without PR", () => {
    const status = formatDispatchStatus({
      consultationId: "cons-001",
      kind: "consult",
      remoteRepo: "acme/proj",
      commitSha: CHECKPOINT_SHA,
      mode: "async",
    });
    expect(status).toBe(`[advisor:consult] dispatching cons-001 (acme/proj@${CHECKPOINT_SHA.slice(0, 7)}, async)`);
  });

  it("formats dispatch status line with PR", () => {
    const status = formatDispatchStatus({
      consultationId: "cons-002",
      kind: "review",
      remoteRepo: "acme/proj",
      commitSha: CHECKPOINT_SHA,
      mode: "sync",
      prNumber: 42,
    });
    expect(status).toContain("pr=#42");
    expect(status).toContain("sync");
  });

  it("formats completion notification with top action items and drift", () => {
    const notification = formatCompletionNotification({
      consultationId: "cons-003",
      kind: "plan",
      drift: { verdict: "checkpoint-is-ancestor", currency: "possibly-stale" },
      actionItems: [
        { ordinal: 1, summary: "Extract core logic to helper", disposition: "pending" },
        { ordinal: 2, summary: "Add regression tests", disposition: "accepted" },
        { ordinal: 3, summary: "Update schema definitions", disposition: "pending" },
        { ordinal: 4, summary: "Fourth item omitted from top list", disposition: "pending" },
      ],
    });

    expect(notification).toContain("[advisor:plan] Consultation cons-003 complete. [drift: possibly-stale]");
    expect(notification).toContain("Top action items:");
    expect(notification).toContain("- [A1] Extract core logic to helper (pending)");
    expect(notification).toContain("- [A2] Add regression tests (accepted)");
    expect(notification).toContain("- [A3] Update schema definitions (pending)");
    expect(notification).not.toContain("Fourth item");
    expect(notification).toContain("Run /advisor-read cons-003 to view full advice.");
  });

  it("formats degraded completion notification", () => {
    const notification = formatCompletionNotification({
      consultationId: "cons-004",
      kind: "debug",
      degradedReason: "Remote rate limited, advisory skipped",
    });

    expect(notification).toContain("completed with degradation: Remote rate limited, advisory skipped");
  });

  it("formats full advisory markdown view", () => {
    const record = {
      schemaVersion: 1 as const,
      consultationId: "adv-0005" as ConsultationId,
      taskId: "task-001",
      kind: "audit" as const,
      status: "completed" as const,
      dependency: "advisory" as const,
      repository: canonicalRepositoryKey("acme", "proj"),
      branch: "main",
      requestedRef: "main",
      resolvedCommit: CHECKPOINT_SHA,
      headAtDispatch: CHECKPOINT_SHA,
      projectId: "p-1",
      conversationId: "c-1",
      createdAt: "2026-09-12T12:00:00.000Z",
      actionItems: [
        { id: "A1", summary: "Harden input sanitization", disposition: "rejected_with_reason" as const, dispositionNote: "Already covered by gateway" },
      ],
    };

    const fullView = formatFullAdvisoryView(record, "Everything looks reasonably secure.");
    expect(fullView).toContain("# Consultation Advisory: adv-0005");
    expect(fullView).toContain("**Kind**: `audit`");
    expect(fullView).toContain(`**Target Checkpoint**: \`${CHECKPOINT_SHA}\``);
    expect(fullView).toContain("- **[A1]** `rejected_with_reason`: Harden input sanitization — Reason: Already covered by gateway");
    expect(fullView).toContain("## Adviser Response");
    expect(fullView).toContain("Everything looks reasonably secure.");
  });
});
