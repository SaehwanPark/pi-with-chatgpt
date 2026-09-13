import { describe, expect, it } from "vitest";

import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import type { ConsultationAnchor } from "../protocol/checkpoint.js";
import {
  JOB_FILE_SCHEMA_VERSION,
  assertJobRecord,
  canTransitionJob,
  createQueuedJob,
  deliveryKeyForSession,
  parseJobFile,
  responsePathForConsultation,
  scopedTaskIdForSession,
  transitionJob,
  type JobRecord,
} from "./record.js";

const SHA = requireFullCommitSha("0f2c8f4a1d6b4f1e9c2d8e6a5b4c3d2e1f0a9b8c");
const RECEIPT_SHA = requireFullCommitSha("1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d");
const REPOSITORY = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");
const CREATED = "2026-09-12T12:00:00.000Z";
const STARTED = "2026-09-12T12:00:01.000Z";
const FINISHED = "2026-09-12T12:00:02.000Z";

function anchor(overrides: Partial<ConsultationAnchor> = {}): ConsultationAnchor {
  return {
    repository: REPOSITORY,
    remoteUrl: "git@github.com:SaehwanPark/pi-with-chatgpt.git",
    requestedRef: "HEAD",
    resolvedCommit: SHA,
    remoteAvailability: { status: "available" },
    ...overrides,
  };
}

function queued(overrides: Partial<Parameters<typeof createQueuedJob>[0]> = {}): JobRecord {
  return createQueuedJob({
    anchor: anchor(),
    branch: "main",
    taskId: "task-alpha",
    kind: "review",
    sessionId: "pi-session-alpha",
    consultationId: "adv-test-1" as JobRecord["consultationId"],
    createdAt: CREATED,
    ...overrides,
  });
}

describe("durable consultation job record", () => {
  it("creates queued schema-v1 state with safe defaults and a delivery digest", () => {
    const record = queued();

    expect(record.state).toBe("queued");
    expect(record.revision).toBe(1);
    expect(record.mode).toBe("async");
    expect(record.dependency).toBe("advisory");
    expect(record.deliveryKey).toBe(deliveryKeyForSession("pi-session-alpha"));
    expect(JSON.stringify(record)).not.toContain("pi-session-alpha");
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.anchor)).toBe(true);

    const file = parseJobFile({ version: JOB_FILE_SCHEMA_VERSION, record });
    expect(file?.record).toEqual(record);
  });

  it("allocates valid stable adviser ids and derives the JSON response path", () => {
    const first = createQueuedJob({
      anchor: anchor(),
      branch: "main",
      taskId: "task-one",
      kind: "consult",
      sessionId: "session-one",
      createdAt: CREATED,
    });
    const second = createQueuedJob({
      anchor: anchor(),
      branch: "main",
      taskId: "task-two",
      kind: "consult",
      sessionId: "session-two",
      createdAt: CREATED,
    });

    expect(first.consultationId).toMatch(/^adv-[0-9a-f-]{36}$/u);
    expect(first.consultationId).not.toBe(second.consultationId);
    expect(responsePathForConsultation(first.consultationId)).toBe(`responses/${first.consultationId}.json`);
  });

  it("namespaces logical task labels without persisting the raw Pi session", () => {
    const scoped = scopedTaskIdForSession("pi-session-alpha", "review");
    expect(scoped).toBe(`pi-session-${deliveryKeyForSession("pi-session-alpha")}-task-review`);
    expect(scoped).not.toContain("pi-session-alpha");
    expect(() => scopedTaskIdForSession("pi-session-alpha", "   ")).toThrow();
    expect(() => scopedTaskIdForSession("pi-session-alpha", "review\nnext")).toThrow();
  });

  it("rejects anchors that are not exact, available GitHub checkpoints", () => {
    expect(() => queued({ anchor: anchor({ resolvedCommit: SHA.toUpperCase() as ConsultationAnchor["resolvedCommit"] }) })).toThrow();
    expect(() => queued({ anchor: anchor({ remoteAvailability: { status: "unknown", reason: "probe-timeout" } }) })).toThrow();
    expect(() => queued({ anchor: anchor({ remoteUrl: "https://github.com/another/repository.git" }) })).toThrow();
    expect(() => queued({ anchor: anchor({ remoteUrl: "https://token@github.com/SaehwanPark/pi-with-chatgpt.git" }) })).toThrow();
  });

  it("keeps the record schema closed and rejects credential-shaped values", () => {
    const record = queued();
    const withUnknown = { ...record, unexpected: true };
    expect(parseJobFile({ version: 1, record: withUnknown })).toBeUndefined();
    expect(parseJobFile({ version: 2, record })).toBeUndefined();
    expect(parseJobFile({ version: 1, record: { ...record, deliveryKey: "not-a-sha256" } })).toBeUndefined();
    expect(() => createQueuedJob({
      anchor: anchor(),
      branch: "main",
      taskId: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      kind: "review",
      sessionId: "session-secret-check",
      createdAt: CREATED,
    })).toThrow();
    expect(() => assertJobRecord(withUnknown)).toThrow("Invalid consultation job record.");
  });

  it("rejects malformed response metadata, timestamp order, and noncanonical remote identity", () => {
    const running = transitionJob(queued(), "running", {
      binding: {
        projectId: "project-123",
        conversationId: "conversation-123",
        headAtDispatch: SHA,
      },
      at: STARTED,
    });
    const completed = transitionJob(running, "completed", {
      result: {
        responsePath: responsePathForConsultation(running.consultationId),
        responseSha256: "a".repeat(64),
        resultStatus: "complete",
        actionItems: [],
      },
      at: FINISHED,
    });

    expect(parseJobFile({
      version: 1,
      record: {
        ...completed,
        result: { ...completed.result, responsePath: `responses/${completed.consultationId}.md` },
      },
    })).toBeUndefined();
    expect(parseJobFile({
      version: 1,
      record: {
        ...completed,
        result: { ...completed.result, responseSha256: "bad-digest" },
      },
    })).toBeUndefined();
    expect(parseJobFile({
      version: 1,
      record: { ...running, updatedAt: CREATED },
    })).toBeUndefined();
    expect(parseJobFile({
      version: 1,
      record: {
        ...completed,
        anchor: {
          ...completed.anchor,
          repository: "Owner/repository" as ConsultationAnchor["repository"],
          remoteUrl: "https://github.com/Owner/repository.git",
        },
      },
    })).toBeUndefined();
    expect(parseJobFile({
      version: 1,
      record: {
        ...completed,
        anchor: {
          ...completed.anchor,
          remoteUrl: "https://github.com/SaehwanPark/pi-with-chatgpt/issues",
        },
      },
    })).toBeUndefined();
  });

  it("allows one queued-to-running claim and one terminal winner", () => {
    const original = queued();
    const binding = { projectId: "project-123", conversationId: "conversation-123", headAtDispatch: SHA } as const;
    const running = transitionJob(original, "running", { binding, at: STARTED });
    expect(running.state).toBe("running");
    expect(running.revision).toBe(2);
    expect(running.binding).toEqual(binding);
    expect(canTransitionJob("queued", "running")).toBe(true);
    expect(canTransitionJob("running", "completed")).toBe(true);
    expect(canTransitionJob("completed", "failed")).toBe(false);

    const result = {
      headAtReceipt: RECEIPT_SHA,
      responsePath: responsePathForConsultation(running.consultationId),
      responseSha256: "a".repeat(64),
      resultStatus: "complete" as const,
      actionItems: [{ id: "A1", summary: "inspect the checkpoint" }],
    };
    const completed = transitionJob(running, "completed", { result, at: FINISHED });
    expect(completed.state).toBe("completed");
    expect(completed.revision).toBe(3);
    expect(transitionJob(completed, "failed", { failure: "timeout" })).toBe(completed);
    expect(transitionJob(running, "failed", { failure: "timeout", at: FINISHED }).state).toBe("failed");
  });

  it("requires state-dependent metadata and rejects unknown failure codes", () => {
    const record = queued();
    expect(parseJobFile({ version: 1, record: { ...record, state: "running", revision: 2 } })).toBeUndefined();
    expect(parseJobFile({ version: 1, record: { ...record, state: "failed", revision: 2, finishedAt: FINISHED } })).toBeUndefined();
    expect(parseJobFile({ version: 1, record: { ...record, state: "failed", revision: 2, finishedAt: FINISHED, failure: "random-exception" } })).toBeUndefined();
  });

  it("refuses identifiers outside the storage filename contract", () => {
    for (const id of ["adv-../../outside", `adv-${"a".repeat(80)}`]) {
      expect(() => queued({ consultationId: id as JobRecord["consultationId"] })).toThrow();
      expect(() => responsePathForConsultation(id as JobRecord["consultationId"])).toThrow();
    }
  });

  it("never rolls the persisted event clock backwards during a transition", () => {
    const original = queued({ updatedAt: STARTED });
    expect(() => transitionJob(original, "cancelled", { at: CREATED })).toThrow();
    expect(transitionJob(original, "cancelled", { at: FINISHED }).finishedAt).toBe(FINISHED);
  });
});
