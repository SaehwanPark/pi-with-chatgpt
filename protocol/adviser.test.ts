import { describe, expect, it } from "vitest";

import {
  ADVISER_NEXT_ACTIONS,
  MANUAL_INTERVENTION_ACTIONS,
  requiresManualIntervention,
  type AdviserNextAction,
} from "./adviser.js";

/**
 * Which actions a human must take are a policy statement, so they are pinned by enumeration rather than
 * by consistency with the code that produced them. The two lists are checked against each other here, and
 * against a fixed expectation, so that adding a new action forces an explicit decision about whether it is
 * human-gated instead of defaulting to whatever the last entry happened to be.
 */
describe("adviser next actions", () => {
  it("gates every action that touches the user's accounts, browser, or git authority", () => {
    // Anything a human must do: sign in somewhere, solve a challenge, copy their own browser state,
    // publish a commit, or decide between accounts.
    const humanOnly: readonly AdviserNextAction[] = [
      "run-pi-login",
      "manual-login",
      "import-chrome-state",
      "solve-verification",
      "stop-unsupported-plan",
      "repair-environment",
      "review-account-mismatch",
      "skip-adviser",
      "choose-adviser-model",
      "connect-github",
      "publish-checkpoint",
    ];
    expect([...MANUAL_INTERVENTION_ACTIONS].sort()).toStrictEqual([...humanOnly].sort());
  });

  it("automates only actions that cannot touch the user or the repository", () => {
    // The complement is the interesting list: what the extension is allowed to do without asking.
    const automatic: readonly AdviserNextAction[] = [
      "create-profile",
      "run-capability-probe",
      "wait-for-rate-limit",
      "consult",
    ];
    const notGated = ADVISER_NEXT_ACTIONS.filter((action) => !requiresManualIntervention(action));
    expect([...notGated].sort()).toStrictEqual([...automatic].sort());
  });

  it("partitions the declared actions with no duplicates on either side", () => {
    // A duplicated entry would make "is this gated?" depend on which list a caller consults, and an
    // action missing from ADVISER_NEXT_ACTIONS would be classified by nothing at all.
    expect(MANUAL_INTERVENTION_ACTIONS.length).toBe(new Set(MANUAL_INTERVENTION_ACTIONS).size);
    expect(ADVISER_NEXT_ACTIONS.length).toBe(new Set(ADVISER_NEXT_ACTIONS).size);
    for (const action of MANUAL_INTERVENTION_ACTIONS) {
      expect(ADVISER_NEXT_ACTIONS).toContain(action);
    }
  });
});
