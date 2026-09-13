import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AdviserProfile } from "../browser/profile.js";
import { SESSION_MARKER_FILE } from "./login-flow.js";
import { authDecisionAllowsConsultation, resolveLiveAdviserAuth } from "./readiness.js";

function profileFor(userDataDir: string): AdviserProfile {
  return { kind: "extension-owned", profileId: "chatgpt-adviser", userDataDir, stateRoot: userDataDir } as const;
}

function piModule(accountId: string) {
  return {
    readStoredCredential: () => ({
      type: "oauth",
      access: "opaque-access-token",
      expires: Date.now() + 3_600_000,
      accountId,
    }),
  };
}

describe("resolveLiveAdviserAuth", () => {
  it("refuses a browser account that differs from Pi's OAuth account", async () => {
    const root = await mkdtemp(join(tmpdir(), "pwc-live-auth-"));
    const profile = profileFor(join(root, "profile"));
    await mkdir(profile.userDataDir, { recursive: true });
    await writeFile(join(profile.userDataDir, SESSION_MARKER_FILE), "signed in\n");

    const decision = await resolveLiveAdviserAuth({
      profile,
      credential: { loadPiModule: () => Promise.resolve(piModule("pi-account")) },
      browserSession: {
        kind: "signed-in",
        identity: {
          source: "chatgpt-browser",
          accountIdHint: "different-account",
          accountIdNamespace: "chatgpt-account",
        },
      },
    });

    expect(decision.state).toBe("account-mismatch");
    expect(decision.action).toBe("review-account-mismatch");
    expect(authDecisionAllowsConsultation(decision)).toBe(false);
  });

  it("refuses a signed-in browser whose account identity cannot be verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "pwc-live-auth-"));
    const profile = profileFor(join(root, "profile"));
    await mkdir(profile.userDataDir, { recursive: true });

    const decision = await resolveLiveAdviserAuth({
      profile,
      credential: { loadPiModule: () => Promise.resolve(piModule("pi-account")) },
      browserSession: { kind: "signed-in" },
    });

    expect(decision.identityComparison).toBe("unknown");
    expect(decision.state).toBe("browser-identity-unverified");
    expect(decision.action).toBe("review-account-mismatch");
    expect(authDecisionAllowsConsultation(decision)).toBe(false);
  });

  it("requires a fresh browser observation instead of treating Pi OAuth as web readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "pwc-live-auth-"));
    const profile = profileFor(join(root, "profile"));
    await mkdir(profile.userDataDir, { recursive: true });

    const decision = await resolveLiveAdviserAuth({
      profile,
      credential: { loadPiModule: () => Promise.resolve(piModule("pi-account")) },
    });

    expect(decision.state).toBe("capability-unverified");
    expect(decision.action).toBe("run-capability-probe");
    expect(authDecisionAllowsConsultation(decision)).toBe(false);
  });
});
