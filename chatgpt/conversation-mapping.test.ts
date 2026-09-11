import { describe, expect, it } from "vitest";

import { fakeProjectSurface, tempStateLayout } from "../test/state-harness.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { KeyedMutex, withConversationWriteLock } from "./conversation-mapping.js";
import {
  ensureConversationForTask,
  type EnsureConversationResult,
} from "./conversation-recovery.js";
import { conversationKeyForTask, type ConversationScope } from "./scope.js";

const REPOSITORY = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");
const PROJECT = { projectId: "project-1", title: "pi-with-chatgpt: saehwanpark/pi-with-chatgpt" } as const;

function scope(taskId: string): ConversationScope {
  return { repository: REPOSITORY, taskId, kind: "review" };
}

function successful(
  result: EnsureConversationResult,
): Extract<EnsureConversationResult, { readonly ok: true }> {
  if (!result.ok) throw new Error(`${result.reason}: ${result.explanation}`);
  return result;
}

function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("task conversation mapping (INV-09)", () => {
  it("gives unrelated tasks different conversations in one Project", async () => {
    const { layout } = await tempStateLayout("conversation-mapping-isolation");
    const surface = fakeProjectSurface({ projects: [PROJECT] });

    const first = successful(
      await ensureConversationForTask({
        layout,
        surface: surface.surface,
        repository: REPOSITORY,
        projectId: PROJECT.projectId,
        scope: scope("task-a"),
      }),
    );
    const second = successful(
      await ensureConversationForTask({
        layout,
        surface: surface.surface,
        repository: REPOSITORY,
        projectId: PROJECT.projectId,
        scope: scope("task-b"),
      }),
    );

    expect(first.record.conversationKey).not.toBe(second.record.conversationKey);
    expect(first.record.conversationId).not.toBe(second.record.conversationId);
    expect(first.record.projectId).toBe(PROJECT.projectId);
    expect(second.record.projectId).toBe(PROJECT.projectId);
    expect(surface.calls.start).toEqual([PROJECT.projectId, PROJECT.projectId]);
  });

  it("reuses the conversation for a follow-up of the same task", async () => {
    const { layout } = await tempStateLayout("conversation-mapping-follow-up");
    const firstSurface = fakeProjectSurface({ projects: [PROJECT] });
    const first = successful(
      await ensureConversationForTask({
        layout,
        surface: firstSurface.surface,
        repository: REPOSITORY,
        projectId: PROJECT.projectId,
        scope: scope("task-a"),
      }),
    );

    // A new surface models a later Pi session: only the persisted mapping and the live remote id remain.
    const secondSurface = fakeProjectSurface({
      projects: [PROJECT],
      conversations: [first.record.conversationId],
    });
    const followUp = successful(
      await ensureConversationForTask({
        layout,
        surface: secondSurface.surface,
        repository: REPOSITORY,
        projectId: PROJECT.projectId,
        scope: scope("task-a"),
      }),
    );

    expect(followUp.outcome).toBe("reused");
    expect(followUp.record.conversationId).toBe(first.record.conversationId);
    expect(followUp.record.conversationKey).toBe(first.record.conversationKey);
    expect(secondSurface.calls.start).toEqual([]);
    expect(secondSurface.calls.inspectConversation).toEqual([first.record.conversationId]);
  });

  it("serialises two writes to one conversation", async () => {
    const mutex = new KeyedMutex();
    const key = conversationKeyForTask(scope("task-a"));
    const firstEntered = gate();
    const allowFirstToFinish = gate();
    const events: string[] = [];
    let secondStarted = false;

    const first = withConversationWriteLock(
      key,
      async () => {
        events.push("first-start");
        firstEntered.open();
        await allowFirstToFinish.promise;
        events.push("first-end");
      },
      mutex,
    );
    await firstEntered.promise;

    const second = withConversationWriteLock(
      key,
      () => {
        secondStarted = true;
        events.push("second-start");
        events.push("second-end");
        return Promise.resolve();
      },
      mutex,
    );

    expect(secondStarted).toBe(false);
    expect(mutex.isContended(key)).toBe(true);
    allowFirstToFinish.open();
    await Promise.all([first, second]);

    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
    expect(mutex.isContended(key)).toBe(false);
  });

  it("lets two tasks consult concurrently", async () => {
    const mutex = new KeyedMutex();
    const firstKey = conversationKeyForTask(scope("task-a"));
    const secondKey = conversationKeyForTask(scope("task-b"));
    const firstEntered = gate();
    const secondEntered = gate();
    const releaseBoth = gate();
    let active = 0;
    let maximumActive = 0;

    const consult = (key: typeof firstKey, entered: { readonly open: () => void }) =>
      withConversationWriteLock(
        key,
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          entered.open();
          await releaseBoth.promise;
          active -= 1;
        },
        mutex,
      );

    const first = consult(firstKey, firstEntered);
    await firstEntered.promise;
    const second = consult(secondKey, secondEntered);
    await secondEntered.promise;

    expect(maximumActive).toBe(2);
    expect(mutex.isContended(firstKey)).toBe(true);
    expect(mutex.isContended(secondKey)).toBe(true);
    releaseBoth.open();
    await Promise.all([first, second]);
    expect(active).toBe(0);
  });
});
