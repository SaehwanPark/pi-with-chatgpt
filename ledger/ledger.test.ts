import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { adviserStateLayout, repositoryStateLayout } from "../config/state-layout.js";
import { ConsultationLedger, type LedgerEntry } from "./ledger.js";
import type { ConsultationId } from "../protocol/checkpoint.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import { UnsafeLedgerRecordError } from "./record.js";

const CHECKPOINT = requireFullCommitSha("8f731e2890123456789012345678901234567890");
const OTHER_COMMIT = requireFullCommitSha("da5c991890123456789012345678901234567890");
const REPO = canonicalRepositoryKey("owner", "my-repo");
const CONSULTATION_ID = "adv-0014" as ConsultationId;

function createTestEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1,
    consultationId: CONSULTATION_ID,
    taskId: "task-001",
    repository: REPO,
    branch: "feat/feature-a",
    requestedRef: "HEAD",
    resolvedCommit: CHECKPOINT,
    reviewedCommit: CHECKPOINT,
    headAtDispatch: CHECKPOINT,
    headAtReceipt: CHECKPOINT,
    prNumber: 42,
    kind: "audit",
    dependency: "advisory",
    projectId: "proj-123",
    conversationId: "conv-456",
    status: "completed",
    resultStatus: "complete",
    actionItems: [
      { id: "A1", summary: "Refactor error handler", disposition: "pending" },
      { id: "A2", summary: "Add regression test", disposition: "pending" },
    ],
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pwc-ledger-test-"));
  const layout = adviserStateLayout(root);
  const ledger = new ConsultationLedger({ layout });
  return { root, layout, ledger };
}

describe("ConsultationLedger (M6)", () => {
  it("appends consultation record and stores full response markdown separately", async () => {
    const { ledger, layout } = await createFixture();
    const entry = createTestEntry();
    const markdownResponse = "# Advice\n\nLooks good to proceed.";

    await ledger.recordConsultation(entry, markdownResponse);

    // 1. Check lookup by ID
    const retrieved = await ledger.getById(CONSULTATION_ID, REPO);
    expect(retrieved).toBeDefined();
    expect(retrieved?.consultationId).toBe(CONSULTATION_ID);
    expect(retrieved?.repository).toBe(REPO);
    expect(retrieved?.resolvedCommit).toBe(CHECKPOINT);
    expect(retrieved?.actionItems).toHaveLength(2);
    expect(retrieved?.responsePath).toBe("responses/adv-0014.md");
    expect(retrieved?.responseSha256).toBeDefined();

    // 2. Read full response markdown
    const storedResponse = await ledger.readResponse(CONSULTATION_ID, REPO);
    expect(storedResponse).toBe(markdownResponse);

    // 3. Verify directory permissions
    const repoLayout = repositoryStateLayout(layout, REPO);
    expect((await stat(repoLayout.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(repoLayout.responsesDir)).mode & 0o777).toBe(0o700);
    expect((await stat(repoLayout.ledgerFile)).mode & 0o777).toBe(0o600);
  });

  it("filters consultations by various criteria", async () => {
    const { ledger } = await createFixture();

    const entry1 = createTestEntry({
      consultationId: "adv-0001" as ConsultationId,
      taskId: "task-A",
      resolvedCommit: CHECKPOINT,
      status: "completed",
      createdAt: "2026-01-01T10:00:00Z",
    });
    const entry2 = createTestEntry({
      consultationId: "adv-0002" as ConsultationId,
      taskId: "task-B",
      resolvedCommit: OTHER_COMMIT,
      status: "failed",
      createdAt: "2026-01-02T10:00:00Z",
    });

    await ledger.recordConsultation(entry1);
    await ledger.recordConsultation(entry2);

    // Filter by repository
    const allForRepo = await ledger.list({ repository: REPO });
    expect(allForRepo).toHaveLength(2);

    // Filter by task
    const taskA = await ledger.list({ repository: REPO, taskId: "task-A" });
    expect(taskA).toHaveLength(1);
    expect(taskA[0]?.consultationId).toBe("adv-0001");

    // Filter by commit
    const commitMatches = await ledger.list({ repository: REPO, resolvedCommit: OTHER_COMMIT });
    expect(commitMatches).toHaveLength(1);
    expect(commitMatches[0]?.consultationId).toBe("adv-0002");

    // Filter by status
    const failedOnes = await ledger.list({ repository: REPO, status: "failed" });
    expect(failedOnes).toHaveLength(1);
    expect(failedOnes[0]?.consultationId).toBe("adv-0002");

    // Filter by date range
    const dateFiltered = await ledger.list({
      repository: REPO,
      since: "2026-01-01T12:00:00Z",
    });
    expect(dateFiltered).toHaveLength(1);
    expect(dateFiltered[0]?.consultationId).toBe("adv-0002");
  });

  it("updates action item disposition cleanly", async () => {
    const { ledger } = await createFixture();
    const entry = createTestEntry();

    await ledger.recordConsultation(entry);

    const updated = await ledger.updateActionItemDisposition({
      consultationId: CONSULTATION_ID,
      repository: REPO,
      actionItemId: "A1",
      disposition: "implemented",
      dispositionNote: "Applied in commit 12345",
    });

    expect(updated.actionItems[0]?.disposition).toBe("implemented");
    expect(updated.actionItems[0]?.dispositionNote).toBe("Applied in commit 12345");
    expect(updated.actionItems[1]?.disposition).toBe("pending"); // unmodified

    // Verify it persisted to disk
    const reloaded = await ledger.getById(CONSULTATION_ID, REPO);
    expect(reloaded?.actionItems[0]?.disposition).toBe("implemented");
    expect(reloaded?.actionItems[0]?.dispositionNote).toBe("Applied in commit 12345");
  });

  it("tolerates interrupted write with a corrupt/truncated trailing line", async () => {
    const { ledger, layout } = await createFixture();
    const entry = createTestEntry();

    await ledger.recordConsultation(entry);

    // Corrupt the ledger file by appending a half-written JSON line
    const repoLayout = repositoryStateLayout(layout, REPO);
    const corruptChunk = '{"schemaVersion": 1, "consultationId": "adv-0099", "repo';
    await writeFile(repoLayout.ledgerFile, `\n${corruptChunk}`, { flag: "a" });

    // Listing should still succeed and return the valid entry
    const entries = await ledger.list({ repository: REPO });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.consultationId).toBe(CONSULTATION_ID);
  });

  it("rejects records containing credentials (INV-12)", async () => {
    const { ledger } = await createFixture();

    const unsafeEntry = createTestEntry({
      failureReason: "Leaked token sk-1234567890123456 in error",
    });

    await expect(ledger.recordConsultation(unsafeEntry)).rejects.toThrow(UnsafeLedgerRecordError);

    const safeEntry = createTestEntry();
    await expect(
      ledger.recordConsultation(safeEntry, "Bearer secret_password_here_12345"),
    ).rejects.toThrow(UnsafeLedgerRecordError);
  });

  it("supports schema version migration and missing fields", async () => {
    const { ledger, layout } = await createFixture();
    const repoLayout = repositoryStateLayout(layout, REPO);

    // Write a legacy record without schemaVersion or new fields
    const legacyLine = JSON.stringify({
      consultationId: "adv-legacy-1",
      repository: REPO,
      resolvedCommit: CHECKPOINT,
      actionItems: [{ id: "A1", summary: "Legacy item" }],
    });

    await ledger.recordConsultation(createTestEntry()); // sets up directories
    await writeFile(repoLayout.ledgerFile, `${legacyLine}\n`, { flag: "a" });

    const retrieved = await ledger.getById("adv-legacy-1" as ConsultationId, REPO);
    expect(retrieved).toBeDefined();
    expect(retrieved?.schemaVersion).toBe(1);
    expect(retrieved?.status).toBe("completed");
    expect(retrieved?.actionItems[0]?.disposition).toBe("pending");
  });
});
