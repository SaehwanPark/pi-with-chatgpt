import { describe, expect, it } from "vitest";

import {
  accountPairKey,
  compareAccountIdentity,
  decideAccountMismatch,
  resolveAccountIdentity,
  unverifiedReason,
  type AccountIdentityHint,
} from "./identity.js";

const piAccount: AccountIdentityHint = {
  source: "pi-oauth",
  accountIdHint: "acct-111",
  accountIdNamespace: "chatgpt-account",
  planHint: "plus",
};
const sameBrowser: AccountIdentityHint = {
  source: "chatgpt-browser",
  accountIdHint: "acct-111",
  accountIdNamespace: "chatgpt-account",
};
const otherBrowser: AccountIdentityHint = {
  source: "chatgpt-browser",
  accountIdHint: "acct-999",
  accountIdNamespace: "chatgpt-account",
};
// A Chromium `gaia_id`: a Google account, in a namespace no ChatGPT account id ever appears in.
const gaiaBrowser: AccountIdentityHint = {
  source: "chatgpt-browser",
  accountIdHint: "acct-111",
  accountIdNamespace: "google-gaia",
};

describe("account identity stability (INV-10)", () => {
  it("matches only on an equal account hint", () => {
    expect(compareAccountIdentity(piAccount, sameBrowser)).toBe("match");
    expect(compareAccountIdentity(piAccount, otherBrowser)).toBe("mismatch");
  });

  it("treats a missing hint or missing identity as unknown, never as a match", () => {
    expect(compareAccountIdentity({ source: "none" }, sameBrowser)).toBe("unknown");
    expect(compareAccountIdentity(piAccount, { source: "chatgpt-browser" })).toBe("unknown");
  });

  it("keeps plan metadata out of the identity comparison", () => {
    // A different plan hint must not look like a different account, and equality of hints is not an
    // entitlement check (the live capability check in M2 decides that).
    expect(compareAccountIdentity({ ...piAccount, planHint: "pro" }, sameBrowser)).toBe("match");
  });
});

describe("identifier namespaces (INV-10)", () => {
  // Chrome reports a Google `gaia_id`; Pi reports a ChatGPT account id. Comparing them for equality
  // is never true, so a rule built on it reports a mismatch forever and teaches the operator to
  // dismiss the alarm. The right answer is "these are not comparable", not "these differ".
  it("refuses to compare identifiers from different namespaces", () => {
    expect(compareAccountIdentity(piAccount, gaiaBrowser)).toBe("unknown");
    expect(unverifiedReason(piAccount, gaiaBrowser)).toBe("namespace-mismatch");
  });

  it("treats an unqualified identifier as uncomparable", () => {
    expect(unverifiedReason(piAccount, { source: "chatgpt-browser", accountIdHint: "acct-111" })).toBe(
      "namespace-absent",
    );
  });

  it("compares within a namespace", () => {
    const other = { ...gaiaBrowser, accountIdHint: "other" };
    expect(compareAccountIdentity(gaiaBrowser, other)).toBe("mismatch");
  });
});

describe("resolveAccountIdentity (the single rule)", () => {
  it("confirms a match", () => {
    expect(resolveAccountIdentity({ piAccount, browserAccount: sameBrowser }).kind).toBe("confirmed");
  });

  it("holds for the user on mismatch instead of picking an account", () => {
    const decision = resolveAccountIdentity({ piAccount, browserAccount: otherBrowser });
    expect(decision.kind).toBe("awaiting-user");
  });

  it("reports an absent side as unverified rather than as a match or a mismatch", () => {
    const noBrowser = resolveAccountIdentity({ piAccount });
    expect(noBrowser).toEqual({ kind: "unverified", reason: "browser-identity-absent", match: "unknown" });
    expect(resolveAccountIdentity({}).kind).toBe("unverified");
    expect(resolveAccountIdentity({ piAccount, browserAccount: gaiaBrowser }).kind).toBe("unverified");
  });

  it("honours each explicit user choice", () => {
    const keep = resolveAccountIdentity({
      piAccount,
      browserAccount: otherBrowser,
      decision: decideAccountMismatch({ piAccount, browserAccount: otherBrowser, choice: "keep-current" }),
    });
    expect(keep.kind).toBe("confirmed");

    // Re-authenticating is still a user-in-the-loop step, not an automatic switch.
    const reauth = resolveAccountIdentity({
      piAccount,
      browserAccount: otherBrowser,
      decision: decideAccountMismatch({ piAccount, browserAccount: otherBrowser, choice: "reauthenticate" }),
    });
    expect(reauth.kind).toBe("awaiting-user");

    const skip = resolveAccountIdentity({
      piAccount,
      browserAccount: otherBrowser,
      decision: decideAccountMismatch({ piAccount, browserAccount: otherBrowser, choice: "skip-adviser" }),
    });
    expect(skip).toEqual({ kind: "skipped", reason: "user-declined", match: "mismatch" });
  });
});

describe("mismatch decisions are scoped to the account pair", () => {
  const forOther = decideAccountMismatch({ piAccount, browserAccount: otherBrowser, choice: "keep-current" });

  it("does not authorise a different browser account", () => {
    // "Keep work@example" clicked, then the adviser profile is signed into personal@example: the
    // earlier click must not carry over to the new account.
    const thirdAccount: AccountIdentityHint = {
      source: "chatgpt-browser",
      accountIdHint: "acct-777",
      accountIdNamespace: "chatgpt-account",
    };
    const resolved = resolveAccountIdentity({ piAccount, browserAccount: thirdAccount, decision: forOther });
    expect(resolved.kind).toBe("awaiting-user");
  });

  it("does not survive a different Pi account either", () => {
    const otherPi: AccountIdentityHint = { ...piAccount, accountIdHint: "acct-555" };
    const resolved = resolveAccountIdentity({
      piAccount: otherPi,
      browserAccount: otherBrowser,
      decision: forOther,
    });
    expect(resolved.kind).toBe("awaiting-user");
  });

  it("still applies while the pair is unchanged", () => {
    const resolved = resolveAccountIdentity({ piAccount, browserAccount: otherBrowser, decision: forOther });
    expect(resolved.kind).toBe("confirmed");
  });

  it("identifies a pair without carrying an identifier", () => {
    const key = accountPairKey(piAccount, otherBrowser);
    expect(key).toHaveLength(16);
    expect(key).not.toContain("acct-111");
    expect(key).not.toContain("acct-999");
    expect(key).toBe(accountPairKey(piAccount, otherBrowser));
    expect(key).not.toBe(accountPairKey(piAccount, sameBrowser));
  });
});
