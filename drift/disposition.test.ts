import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { adviserStateLayout } from "../config/state-layout.js";
import { ConsultationLedger, type LedgerEntry } from "../ledger/ledger.js";
import { recordActionItemDisposition, DispositionValidationError } from "./disposition.js";
import type { ConsultationId } from "../protocol/checkpoint.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import { UnsafeLedgerRecordError } from "../ledger/record.js";

const CHECKPOINT = requireFullCommitSha("8f731e2890123456789012345678901234567890");
const REPO = canonicalRepositoryKey("owner", "my-repo");
const CONSULTATION_ID = "adv-0014" as ConsultationId;

function createTestEntry(): LedgerEntry {
  return {
    schemaVersion: 1,
    consultationId: CONSULTATION_ID,
    taskId: "task-001",
    repository: REPO,
    branch: "main",
    requestedRef: "HEAD",
    resolvedCommit: CHECKPOINT,
    headAtDispatch: CHECKPOINT,
    kind: "audit",
    dependency: "advisory",
    projectId: "proj-1",
    conversationId: "conv-1",
    status: "completed",
    actionItems: [
      { id: "A1", summary: "Use secure token generator", disposition: "pending" },
      { id: "A2", summary: "Refactor legacy parser", disposition: "pending" },
    ],
    createdAt: new Date().toISOString(),
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pwc-disp-test-"));
  const layout = adviserStateLayout(root);
  const ledger = new ConsultationLedger({ layout });
  await ledger.recordConsultation(createTestEntry());
  return { ledger };
}

describe("recordActionItemDisposition (M7)", () => {
  it("records accepted disposition without reason", async () => {
    const { ledger } = await createFixture();
    const updated = await recordActionItemDisposition(ledger, {
      consultationId: CONSULTATION_ID,
      repository: REPO,
      actionItemId: "A1",
      disposition: "accepted",
    });

    expect(updated.actionItems[0]?.disposition).toBe("accepted");
    expect(updated.actionItems[0]?.dispositionNote).toBeUndefined();
  });

  it("requires reason when marking rejected_with_reason", async () => {
    const { ledger } = await createFixture();

    await expect(
      recordActionItemDisposition(ledger, {
        consultationId: CONSULTATION_ID,
        repository: REPO,
        actionItemId: "A1",
        disposition: "rejected_with_reason",
      }),
    ).rejects.toThrow(DispositionValidationError);

    const updated = await recordActionItemDisposition(ledger, {
      consultationId: CONSULTATION_ID,
      repository: REPO,
      actionItemId: "A1",
      disposition: "rejected_with_reason",
      reason: "Conflicts with backward compatibility policy",
    });

    expect(updated.actionItems[0]?.disposition).toBe("rejected_with_reason");
    expect(updated.actionItems[0]?.dispositionNote).toBe("Conflicts with backward compatibility policy");
  });

  it("rejects disposition note containing credentials (INV-12)", async () => {
    const { ledger } = await createFixture();

    await expect(
      recordActionItemDisposition(ledger, {
        consultationId: CONSULTATION_ID,
        repository: REPO,
        actionItemId: "A1",
        disposition: "implemented",
        reason: "Fixed using ghp_1234567890123456",
      }),
    ).rejects.toThrow(UnsafeLedgerRecordError);
  });
});
