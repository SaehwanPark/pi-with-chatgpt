import { describe, expect, it } from "vitest";

import {
  canTransition,
  IllegalJobTransitionError,
  isTerminalJobState,
  JOB_STATES,
  TERMINAL_JOB_STATES,
  type JobState,
} from "./state.js";


describe("consultation job state machine (INV-09, INV-15)", () => {
  it("allows a job to fail before it ever runs", () => {
    // Preflight rejects in draft; dispatch preconditions (checkpoint not remote, no browser) fail in queued.
    expect(canTransition("draft", "failed")).toBe(true);
    expect(canTransition("queued", "failed")).toBe(true);
    expect(canTransition("completed", "failed")).toBe(false);
  });

  it("lists the states the roadmap requires", () => {
    for (const required of ["queued", "running", "completed", "failed", "cancelled"]) {
      expect(JOB_STATES).toContain(required);
    }
  });

  it.each([
    ["draft", "queued"],
    ["queued", "running"],
    ["running", "awaiting-input"],
    ["awaiting-input", "running"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["queued", "expired"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ["completed", "running"],
    ["completed", "failed"],
    ["failed", "running"],
    ["cancelled", "queued"],
    ["expired", "running"],
    ["draft", "completed"],
    ["queued", "completed"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    // The error the engine throws names both ends, which is what makes a stuck job diagnosable.
    expect(new IllegalJobTransitionError(from, to).message).toBe(`Illegal consultation job transition ${from} -> ${to}.`);
  });

  it("treats finished states as terminal", () => {
    expect(TERMINAL_JOB_STATES).toEqual(["completed", "failed", "cancelled", "expired"]);
    for (const state of JOB_STATES) {
      const terminal = isTerminalJobState(state);
      expect(terminal).toBe((TERMINAL_JOB_STATES as readonly JobState[]).includes(state));
      if (terminal) expect(JOB_STATES.filter((next) => canTransition(state, next))).toEqual([]);
    }
  });
});
