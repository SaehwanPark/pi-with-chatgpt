import { describe, expect, it } from "vitest";

import { classifyCapabilityProbe, type CapabilityRecord } from "../browser/capability.js";
import { requiresManualIntervention } from "../protocol/adviser.js";
import { resolveAdviserAuth, type AdviserAuthFacts } from "./adviser-auth.js";
import { decideAccountMismatch, type AccountMismatchChoice } from "./identity.js";

/* Both fixtures declare a namespace: identifiers only compare inside one, and a fixture without it
 * would exercise the "cannot tell" path instead of the match/mismatch path it names. */
const PI_IDENTITY = {
  source: "pi-oauth",
  accountIdHint: "acct-1",
  accountIdNamespace: "chatgpt-account",
  emailMasked: "a***@example.com",
} as const;
const OTHER_IDENTITY = {
  source: "chatgpt-browser",
  accountIdHint: "acct-2",
  accountIdNamespace: "chatgpt-account",
  emailMasked: "g***@example.com",
} as const;

/** Mint a decision the way the UI must: bound to the pair that was shown. */
function chosen(choice: AccountMismatchChoice): AdviserAuthFacts["mismatchDecision"] {
  return decideAccountMismatch({ piAccount: PI_IDENTITY, browserAccount: OTHER_IDENTITY, choice });
}
const READY: CapabilityRecord = classifyCapabilityProbe({ kind: "signed-in" }, "2026-01-01T00:00:00.000Z");

function facts(overrides: Partial<AdviserAuthFacts> = {}): AdviserAuthFacts {
  return {
    piCredentialPresent: true,
    piCredentialIsApiKey: false,
    piCredentialExpired: false,
    piIdentity: PI_IDENTITY,
    profilePresent: true,
    profileInitialized: true,
    chromeImportAvailable: false,
    capability: READY,
    browserIdentity: { ...PI_IDENTITY, source: "chatgpt-browser" },
    ...overrides,
  };
}

describe("resolveAdviserAuth precedence", () => {
  it("asks for Pi login before touching a browser", () => {
    const decision = resolveAdviserAuth(
      facts({ piCredentialPresent: false, profilePresent: false, capability: undefined }),
    );
    expect(decision.state).toBe("pi-credential-missing");
    expect(decision.action).toBe("run-pi-login");
    expect(decision.requiresManualIntervention).toBe(true);
  });

  it("treats an API key as no usable account", () => {
    const decision = resolveAdviserAuth(facts({ piCredentialIsApiKey: true }));
    expect(decision.state).toBe("pi-credential-api-key");
    expect(decision.action).toBe("run-pi-login");
  });

  it("creates the profile before probing it", () => {
    const decision = resolveAdviserAuth(facts({ profilePresent: false, capability: undefined }));
    expect(decision.action).toBe("create-profile");
  });

  it("verifies capability before offering to consult", () => {
    const decision = resolveAdviserAuth(facts({ capability: undefined }));
    expect(decision.state).toBe("capability-unverified");
    expect(decision.action).toBe("run-capability-probe");
  });

  it("notes an expired token without blocking the consultation", () => {
    // Pi refreshes access tokens on its own; treating expiry as fatal would break working setups.
    const decision = resolveAdviserAuth(facts({ piCredentialExpired: true }));
    expect(decision.action).toBe("consult");
    expect(decision.warnings.join(" ")).toMatch(/expiry/iu);
  });
});

describe("resolveAdviserAuth capability states", () => {
  function withCapability(observed: Parameters<typeof classifyCapabilityProbe>[0], overrides: Partial<AdviserAuthFacts> = {}) {
    return resolveAdviserAuth(
      facts({ capability: classifyCapabilityProbe(observed, "2026-01-01T00:00:00.000Z"), ...overrides }),
    );
  }

  it("prefers an available Chrome import over an interactive login", () => {
    const importable = withCapability({ kind: "signed-out" }, { chromeImportAvailable: true });
    const interactive = withCapability({ kind: "signed-out" }, { chromeImportAvailable: false });
    expect(importable.action).toBe("import-chrome-state");
    expect(interactive.action).toBe("manual-login");
  });

  it("asks a human to solve a challenge and never retries", () => {
    const decision = withCapability({ kind: "human-verification", challenge: "cloudflare" });
    expect(decision.state).toBe("manual-intervention");
    expect(decision.action).toBe("solve-verification");
    expect(decision.requiresManualIntervention).toBe(true);
  });

  it("keeps a rate limit automatic", () => {
    const decision = withCapability({ kind: "rate-limited", retryAfterSeconds: 42 });
    expect(decision.action).toBe("wait-for-rate-limit");
    expect(decision.retryAfterSeconds).toBe(42);
    expect(decision.requiresManualIntervention).toBe(false);
  });

  it("stops on an unsupported plan", () => {
    const decision = withCapability({ kind: "plan-unsupported", planHint: "free" });
    expect(decision.state).toBe("plan-unsupported");
    expect(decision.action).toBe("stop-unsupported-plan");
  });

  it("reports an unavailable environment separately from a missing login", () => {
    const decision = withCapability({ kind: "environment-unavailable", reason: "no-display" });
    expect(decision.state).toBe("environment-unavailable");
    expect(decision.state).not.toBe("sign-in-required");
  });

  it("never lets a non-ready capability reach consult", () => {
    const observations = [
      { kind: "signed-out" },
      { kind: "human-verification", challenge: "captcha" },
      { kind: "rate-limited" },
      { kind: "plan-unsupported", planHint: "free" },
      { kind: "environment-unavailable", reason: "network" },
    ] as const;
    for (const observation of observations) {
      expect(withCapability(observation).action).not.toBe("consult");
    }
  });
});

describe("resolveAdviserAuth identity", () => {
  it("refuses to consult across a silent account switch", () => {
    const decision = resolveAdviserAuth(facts({ browserIdentity: OTHER_IDENTITY }));
    expect(decision.state).toBe("account-mismatch");
    expect(decision.action).toBe("review-account-mismatch");
    expect(decision.action).not.toBe("consult");
  });

  it("proceeds only on an explicit keep-current choice, and says which account is being billed", () => {
    const decision = resolveAdviserAuth(
      facts({ browserIdentity: OTHER_IDENTITY, mismatchDecision: chosen("keep-current") }),
    );
    expect(decision.state).toBe("ready-unverified-identity");
    expect(decision.action).toBe("consult");
    expect(decision.warnings.join(" ")).toMatch(/that account/iu);
    // A kept mismatch is reported as the mismatch it is; a decision to proceed is not evidence that the
    // two accounts turned out to be the same.
    expect(decision.identityComparison).toBe("mismatch");
  });

  it("turns a reauthenticate choice into the login prompt, not into progress", () => {
    const decision = resolveAdviserAuth(
      facts({ browserIdentity: OTHER_IDENTITY, mismatchDecision: chosen("reauthenticate") }),
    );
    expect(decision.action).toBe("manual-login");
    expect(decision.action).not.toBe("consult");
  });

  it("honours a decision to skip the adviser", () => {
    const decision = resolveAdviserAuth(
      facts({ browserIdentity: OTHER_IDENTITY, mismatchDecision: chosen("skip-adviser") }),
    );
    expect(decision.state).toBe("adviser-skipped");
    expect(decision.action).toBe("skip-adviser");
  });

  it("calls an unconfirmable identity unverified rather than matched", () => {
    const decision = resolveAdviserAuth(facts({ browserIdentity: { source: "chatgpt-browser" } }));
    expect(decision.state).toBe("ready-unverified-identity");
    expect(decision.identityComparison).toBe("unknown");
    // Usable, but the operator is told the check did not happen.
    expect(decision.warnings.join(" ")).toMatch(/unverified/iu);
  });

  it("matches on account id", () => {
    const decision = resolveAdviserAuth(facts({ browserIdentity: { ...PI_IDENTITY, source: "chatgpt-browser" } }));
    expect(decision.identityComparison).toBe("match");
    expect(decision.state).toBe("ready");
  });

  it("treats a Pi API-key identity as no identity at all", () => {
    // source "none" can never match, and must not read as a mismatch either.
    const decision = resolveAdviserAuth(facts({ piIdentity: { source: "none" } }));
    expect(decision.identityComparison).toBe("unknown");
    expect(decision.state).toBe("ready-unverified-identity");
    expect(decision.action).toBe("consult");
  });

  it("distinguishes cross-namespace ids from a mismatch instead of alarming on both", () => {
    // A Chromium gaia_id and a ChatGPT account id are different kinds of thing. Calling that a
    // mismatch would block every real session; calling it a match would be a guess.
    const gaia = { source: "chatgpt-browser", accountIdHint: "gaia-9", accountIdNamespace: "google-gaia" } as const;
    const decision = resolveAdviserAuth(facts({ browserIdentity: gaia }));
    expect(decision.identityComparison).toBe("unknown");
    expect(decision.state).toBe("ready-unverified-identity");
    expect(decision.warnings.join(" ")).toMatch(/namespace-mismatch/u);
  });

  it("does not carry a keep-current choice over to a different browser account", () => {
    // The decision the operator clicked belongs to the pair it was shown for. A third account
    // appearing later has to be confirmed again, or one click would authorise every account after it.
    const decision = resolveAdviserAuth(
      facts({ browserIdentity: OTHER_IDENTITY, mismatchDecision: chosen("keep-current") }),
    );
    expect(decision.state).toBe("ready-unverified-identity");

    const anotherAccount = { ...OTHER_IDENTITY, accountIdHint: "acct-3" } as const;
    const keepCurrent = chosen("keep-current");
    const fresh = resolveAdviserAuth(
      facts({ browserIdentity: anotherAccount, mismatchDecision: keepCurrent }),
    );
    expect(fresh.state).toBe("account-mismatch");
    expect(fresh.action).toBe("review-account-mismatch");
  });
});

describe("decision consistency", () => {
  it("agrees with the shared manual-intervention vocabulary", () => {
    const cases = [
      facts({ piCredentialPresent: false }),
      facts({ capability: undefined }),
      facts({ capability: classifyCapabilityProbe({ kind: "signed-out" }, "2026-01-01T00:00:00Z") }),
      facts({ capability: classifyCapabilityProbe({ kind: "rate-limited" }, "2026-01-01T00:00:00Z") }),
      facts({ browserIdentity: OTHER_IDENTITY }),
      facts(),
    ];
    for (const input of cases) {
      const decision = resolveAdviserAuth(input);
      expect(decision.requiresManualIntervention).toBe(requiresManualIntervention(decision.action));
    }
  });
});
