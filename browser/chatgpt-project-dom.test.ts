import { describe, expect, it } from "vitest";

import {
  classifyConversationPresence,
  classifyProjectPresence,
  parseConversationIdFromHref,
  parseProjectEntries,
  parseProjectIdFromHref,
} from "./chatgpt-dom.js";

describe("Project and conversation DOM decisions (M4)", () => {
  it("accepts only opaque ids from ChatGPT-hosted links", () => {
    expect(parseProjectIdFromHref("https://chatgpt.com/p/project-123?tab=settings")).toBe("project-123");
    expect(parseProjectIdFromHref("/project/project-123")).toBe("project-123");
    expect(parseProjectIdFromHref("https://evil.example/p/project-123")).toBeUndefined();
    expect(parseProjectIdFromHref("https://chatgpt.com/p/not safe")).toBeUndefined();
    expect(parseProjectIdFromHref("https://evil.chatgpt.com/p/project-123")).toBeUndefined();

    expect(parseConversationIdFromHref("https://chatgpt.com/g/conversation-123")).toBe("conversation-123");
    expect(parseConversationIdFromHref("/c/conversation-123#latest")).toBe("conversation-123");
    expect(parseConversationIdFromHref("https://evil.example/g/conversation-123")).toBeUndefined();
  });

  it("drops unreadable cards and duplicate ids without guessing", () => {
    expect(
      parseProjectEntries([
        { href: "/p/project-123", label: "First title" },
        { href: "/p/project-123", label: "Duplicate title" },
        { href: "/p/project-456", label: "" },
        { href: undefined, label: "No id" },
      ]),
    ).toEqual([{ projectId: "project-123", title: "First title" }]);
  });

  it("keeps an inconclusive Project probe from becoming deletion evidence", () => {
    expect(classifyProjectPresence(undefined, "project-123", { signedOut: false, loaded: false })).toEqual({
      state: "unknown",
      reason: "surface-unrecognised",
    });
    expect(
      classifyProjectPresence([{ projectId: "project-123", title: "Project" }], "project-123", {
        signedOut: false,
        loaded: true,
      }),
    ).toEqual({ state: "present", title: "Project" });
  });

  it("treats provider and login surfaces as unknown conversations, not deleted ones", () => {
    expect(classifyConversationPresence({ surface: "provider-error", showsDeletedNotice: false })).toEqual({
      state: "unknown",
      reason: "network",
    });
    expect(classifyConversationPresence({ surface: "signed-out", showsDeletedNotice: false })).toEqual({
      state: "unknown",
      reason: "needs-human",
    });
    expect(classifyConversationPresence({ surface: "unknown", showsDeletedNotice: true })).toEqual({
      state: "gone",
    });
  });
});
