import { describe, expect, it } from "vitest";

import { fakeProjectSurface, tempStateLayout } from "../test/state-harness.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import {
  assertProvenanceIsCheckpointAnchored,
  ensureConversationForTask,
  renderTaskHandoff,
  type EnsureConversationResult,
} from "./conversation-recovery.js";
import type { ConversationScope } from "./scope.js";

const REPOSITORY = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");
const PROJECT = { projectId: "project-1", title: "pi-with-chatgpt: saehwanpark/pi-with-chatgpt" } as const;
const PREVIOUS_CHECKPOINT = requireFullCommitSha("1".repeat(40));
const CURRENT_CHECKPOINT = requireFullCommitSha("2".repeat(40));

function scope(taskId = "task-a"): ConversationScope {
  return { repository: REPOSITORY, taskId, kind: "review" };
}

function successful(
  result: EnsureConversationResult,
): Extract<EnsureConversationResult, { readonly ok: true }> {
  if (!result.ok) throw new Error(`${result.reason}: ${result.explanation}`);
  return result;
}

async function startInitialConversation(
  layout: Awaited<ReturnType<typeof tempStateLayout>>["layout"],
  surface: ReturnType<typeof fakeProjectSurface>,
) {
  return successful(
    await ensureConversationForTask({
      layout,
      surface: surface.surface,
      repository: REPOSITORY,
      projectId: PROJECT.projectId,
      scope: scope(),
    }),
  );
}

function markConversationDeleted(surface: ReturnType<typeof fakeProjectSurface>, conversationId: string): void {
  surface.conversations.delete(conversationId);
  // Keep the fake's id allocator moving so a replacement can be distinguished from the deleted id.
  surface.conversations.add("unrelated-live-conversation");
}

describe("conversation recovery (INV-09, INV-14)", () => {
  it("replaces a deleted conversation inside the same Project", async () => {
    const { layout } = await tempStateLayout("conversation-recovery-replace");
    const surface = fakeProjectSurface({ projects: [PROJECT] });
    const initial = await startInitialConversation(layout, surface);
    markConversationDeleted(surface, initial.record.conversationId);

    const replacement = successful(
      await ensureConversationForTask({
        layout,
        surface: surface.surface,
        repository: REPOSITORY,
        projectId: PROJECT.projectId,
        scope: scope(),
      }),
    );

    expect(replacement.outcome).toBe("replaced");
    expect(replacement.record.projectId).toBe(PROJECT.projectId);
    expect(replacement.record.conversationId).not.toBe(initial.record.conversationId);
    expect(replacement.record.state).toBe("active");
    expect(surface.calls.start).toEqual([PROJECT.projectId, PROJECT.projectId]);
    expect(replacement.note).toMatch(/same Project/u);
  });

  it("attaches a handoff brief that names both checkpoints", async () => {
    const { layout } = await tempStateLayout("conversation-recovery-handoff");
    const surface = fakeProjectSurface({ projects: [PROJECT] });
    const initial = await startInitialConversation(layout, surface);
    markConversationDeleted(surface, initial.record.conversationId);

    const replacement = successful(
      await ensureConversationForTask({
        layout,
        surface: surface.surface,
        repository: REPOSITORY,
        projectId: PROJECT.projectId,
        scope: scope(),
        continuity: { previous: PREVIOUS_CHECKPOINT, current: CURRENT_CHECKPOINT },
      }),
    );

    expect(replacement.outcome).toBe("replaced");
    expect(replacement.handoff).toEqual({
      taskId: "task-a",
      kind: "review",
      previousConversationId: initial.record.conversationId,
      previousCheckpoint: PREVIOUS_CHECKPOINT,
      currentCheckpoint: CURRENT_CHECKPOINT,
    });
    if (replacement.handoff === undefined) return;
    const rendered = renderTaskHandoff(replacement.handoff);
    expect(rendered).toContain(`Previous conversation reviewed ${PREVIOUS_CHECKPOINT}.`);
    expect(rendered).toContain(`This request is anchored to ${CURRENT_CHECKPOINT}.`);
    // Recovery returns the handoff to the dispatcher; it must not claim that the text was sent before M5/M6
    // performs that effect.
    expect(replacement.record.handoffAt).toBeUndefined();
  });

  it("never substitutes Project memory for the checkpoint", () => {
    const handoff = renderTaskHandoff({
      taskId: "task-a",
      kind: "review",
      previousConversationId: "conversation-old",
      previousCheckpoint: PREVIOUS_CHECKPOINT,
      currentCheckpoint: CURRENT_CHECKPOINT,
    });

    expect(handoff).toContain("Do not rely on Project memory");
    expect(() => assertProvenanceIsCheckpointAnchored(handoff, CURRENT_CHECKPOINT)).not.toThrow();

    const memorySubstitute = `Project memory says the previous answer applies to ${PREVIOUS_CHECKPOINT}.`;
    expect(() => assertProvenanceIsCheckpointAnchored(memorySubstitute, CURRENT_CHECKPOINT)).toThrow(
      /provenance/u,
    );
  });
});
