import { describe, expect, it } from "vitest";

import { deriveTaskIdentity } from "./task-identity.js";
import { conversationKeyForTask } from "./scope.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";

const REPOSITORY = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");

describe("task identity (INV-09)", () => {
  it("prefers an explicit task id so a retry reuses its conversation", () => {
    const first = deriveTaskIdentity({ explicitTaskId: "checkpoint-ownership", piSessionId: "pi-1" });
    const second = deriveTaskIdentity({ explicitTaskId: "checkpoint-ownership", piSessionId: "pi-2" });
    expect(first.taskId).toBe(second.taskId);
    expect(first.origin).toBe("explicit");
  });

  it("falls back to the Pi session id, which is one task per Pi run", () => {
    expect(deriveTaskIdentity({ piSessionId: "pi-0142", workspacePath: "/home/ada/work/widget" }).taskId).toBe("pi-0142");
  });

  it("never embeds the workspace path", () => {
    const identity = deriveTaskIdentity({ workspacePath: "/home/ada/private-checkout" });
    expect(identity.taskId).not.toContain("ada");
    expect(identity.taskId).not.toContain("private-checkout");
    // Weaker isolation must be reported, not presented as safe: unrelated tasks share this thread.
    expect(identity.origin).toBe("workspace-fallback");
    expect(identity.note).toContain("share one adviser conversation");
  });

  it("strips separators so a task id cannot forge another repository's key", () => {
    const forged = deriveTaskIdentity({ explicitTaskId: `other/repo:task:${"x".repeat(40)}` });
    expect(forged.taskId).not.toContain("/");
    expect(forged.taskId).not.toContain(":");
    // Defence in depth: the conversation key percent-encodes the task, so two different tasks cannot
    // produce the same key by smuggling a separator.
    const keyFor = (taskId: string) =>
      conversationKeyForTask({ repository: REPOSITORY, taskId, kind: "review" });
    expect(keyFor("a:b")).not.toBe(keyFor("a"));
    expect(keyFor("a:b")).not.toBe(keyFor("a%3Ab"));
  });
});
