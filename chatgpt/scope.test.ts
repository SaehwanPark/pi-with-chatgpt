import { describe, expect, it } from "vitest";

import {
  conversationKeyForTask,
  CONSULTATION_KINDS,
  isConsultationKind,
  projectKeyForRepository,
} from "./scope.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";

const repo = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");
const otherRepo = canonicalRepositoryKey("SaehwanPark", "something-else");

describe("one Project per repository (INV-08)", () => {
  it("maps a repository to a single Project key", () => {
    expect(projectKeyForRepository(repo)).toBe("adviser:github:saehwanpark/pi-with-chatgpt");
  });

  it("is stable across sessions, branches, and tasks because none of those are inputs", () => {
    const first = projectKeyForRepository(repo);
    const again = projectKeyForRepository(canonicalRepositoryKey("saehwanpark", "pi-with-chatgpt"));
    expect(again).toBe(first);
  });

  it("separates repositories", () => {
    expect(projectKeyForRepository(otherRepo)).not.toBe(projectKeyForRepository(repo));
  });
});

describe("task conversation isolation (INV-09)", () => {
  it("gives unrelated tasks different conversations", () => {
    const a = conversationKeyForTask({ repository: repo, taskId: "task-a", kind: "consult" });
    const b = conversationKeyForTask({ repository: repo, taskId: "task-b", kind: "consult" });
    expect(a).not.toBe(b);
  });

  it("keeps the same task and kind stable so retries reuse the conversation", () => {
    const first = conversationKeyForTask({ repository: repo, taskId: "task-a", kind: "review" });
    const retry = conversationKeyForTask({ repository: repo, taskId: "task-a", kind: "review" });
    expect(retry).toBe(first);
  });

  it("separates request kinds within a task", () => {
    const plan = conversationKeyForTask({ repository: repo, taskId: "task-a", kind: "plan" });
    const review = conversationKeyForTask({ repository: repo, taskId: "task-a", kind: "review" });
    expect(plan).not.toBe(review);
  });

  it("refuses a repository-wide shared thread", () => {
    expect(() => conversationKeyForTask({ repository: repo, taskId: "  ", kind: "consult" })).toThrow(/task identity/u);
  });

  it("supports exactly the documented request kinds", () => {
    expect(CONSULTATION_KINDS).toEqual(["consult", "plan", "review", "audit", "debug", "challenge"]);
    expect(isConsultationKind("consult")).toBe(true);
    expect(isConsultationKind("vibe-check")).toBe(false);
  });
});
