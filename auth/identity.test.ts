import { describe, expect, it } from "vitest";

import { compareAccountIdentity, resolveAccountMismatch, type AccountIdentityHint } from "./identity.js";

const piAccount: AccountIdentityHint = { source: "pi-oauth", accountIdHint: "acct-111", planHint: "plus" };
const sameBrowser: AccountIdentityHint = { source: "chatgpt-browser", accountIdHint: "acct-111" };
const otherBrowser: AccountIdentityHint = { source: "chatgpt-browser", accountIdHint: "acct-999" };

describe("account identity stability (INV-10)", () => {
  it("matches only on an equal account hint", () => {
    expect(compareAccountIdentity(piAccount, sameBrowser)).toBe("match");
    expect(compareAccountIdentity(piAccount, otherBrowser)).toBe("mismatch");
  });

  it("treats a missing hint or missing identity as unknown, never as a match", () => {
    expect(compareAccountIdentity({ source: "none" }, sameBrowser)).toBe("unknown");
    expect(compareAccountIdentity(piAccount, { source: "chatgpt-browser" })).toBe("unknown");
  });

  it("holds for the user on mismatch instead of picking an account", () => {
    const resolution = resolveAccountMismatch(otherBrowser, "mismatch");
    expect(resolution.kind).toBe("awaiting-user");
  });

  it("never proceeds silently from an unknown match", () => {
    expect(resolveAccountMismatch(sameBrowser, "unknown").kind).toBe("awaiting-user");
  });

  it("honours each explicit user choice", () => {
    expect(resolveAccountMismatch(otherBrowser, "mismatch", "keep-current")).toEqual({
      kind: "proceed",
      account: otherBrowser,
    });
    // Re-authenticating is still a user-in-the-loop step, not an automatic switch.
    expect(resolveAccountMismatch(otherBrowser, "mismatch", "reauthenticate").kind).toBe("awaiting-user");
    expect(resolveAccountMismatch(otherBrowser, "mismatch", "skip-adviser")).toEqual({
      kind: "skipped",
      reason: "user-declined",
    });
  });

  it("keeps plan metadata out of the identity comparison", () => {
    // A different plan hint must not look like a different account, and equality of hints is not an
    // entitlement check (the live capability check in M2 decides that).
    expect(compareAccountIdentity({ ...piAccount, planHint: "pro" }, sameBrowser)).toBe("match");
  });
});
