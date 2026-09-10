/**
 * Cross-cutting check (M2): every adviser string the worker is allowed to see stays free of browser
 * and credential material.
 *
 * `ui/worker-facing.ts` guards the *keys* of the advisory payload, but the auth layer produces
 * human-readable explanations that travel inside those payloads as values. An explanation that quotes a
 * cookie path, a profile directory, or a token fragment would pass a key-based filter untouched, so the
 * same strings are checked here at the point where they are produced.
 */

import { describe, expect, it } from "vitest";

import { resolveAdviserAuth, type AdviserAuthFacts } from "../auth/adviser-auth.js";
import { describeWorkerAndAdviser } from "../auth/worker-independence.js";
import { planChromeStateImport } from "../browser/cookie-import.js";
import { detectBrowserStateSources, type BrowserStateSourceFileSystem } from "../browser/chrome-state.js";
import { decideAccountMismatch } from "../auth/identity.js";
import type { CapabilityRecord } from "../browser/capability.js";

/**
 * Credential *material* and browser locations, not mere topics. Prose about "the access token" is fine
 * to show a worker; a token value, a cookie database path, or a Chromium profile root is not, and a
 * pattern that bans the English words would fail on every explanation and get switched off.
 */
const WORKER_UNSAFE =
  /eyJ[A-Za-z0-9_-]{8,}|ya29\.[A-Za-z0-9_-]{8,}|Bearer\s|refresh[_-]?token\s*[:=]|access[_-]?token\s*[:=]|\/\.config\/|\/Library\/Application Support|user[_-]data-dir|google-chrome|\bNetwork\/Cookies\b/iu;

/** Complete email addresses and unmasked numeric identifiers — a profile picker must carry neither. */
const PERSONAL_DATA = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}|\b\d{12,}\b/u;

const BASE: AdviserAuthFacts = {
  piCredentialPresent: true,
  piCredentialIsApiKey: false,
  piCredentialExpired: false,
  profilePresent: true,
  profileInitialized: true,
  chromeImportAvailable: false,
};

const PI_ACCOUNT = { source: "pi-oauth", accountIdHint: "bbbb2222", accountIdNamespace: "chatgpt-account" } as const;
const BROWSER_ACCOUNT = {
  source: "chatgpt-browser",
  accountIdHint: "aaaa1111",
  accountIdNamespace: "chatgpt-account",
} as const;

function capability(status: CapabilityRecord["status"], explanation: string): CapabilityRecord {
  return {
    status,
    checkedAt: new Date().toISOString(),
    explanation,
    requiresManualIntervention: status !== "ready",
    nextAction: status === "ready" ? "consult" : "manual-login",
  };
}

describe("adviser strings are worker-safe", () => {
  it("keeps every auth explanation free of credential and browser material", () => {
    const scenarios: AdviserAuthFacts[] = [
      { ...BASE, piCredentialPresent: false },
      { ...BASE, piCredentialIsApiKey: true },
      { ...BASE, piCredentialExpired: true },
      { ...BASE, profilePresent: false },
      { ...BASE, profileInitialized: false },
      { ...BASE, profileInitialized: false, capability: undefined },
      { ...BASE, capability: capability("sign-in-required", "ChatGPT asked for sign-in.") },
      { ...BASE, capability: capability("manual-intervention-required", "A verification challenge was presented.") },
      { ...BASE, capability: capability("rate-limited", "Rate limited by ChatGPT.") },
      { ...BASE, capability: capability("plan-unsupported", "The plan does not include the adviser model.") },
      { ...BASE, capability: capability("environment-unavailable", "The adviser browser could not start.") },
      { ...BASE, browserIdentity: BROWSER_ACCOUNT, piIdentity: PI_ACCOUNT },
      {
        ...BASE,
        browserIdentity: BROWSER_ACCOUNT,
        piIdentity: PI_ACCOUNT,
        mismatchDecision: decideAccountMismatch({
          piAccount: PI_ACCOUNT,
          browserAccount: BROWSER_ACCOUNT,
          choice: "skip-adviser",
        }),
      },
    ];

    for (const facts of scenarios) {
      const decision = resolveAdviserAuth(facts);
      const strings = [decision.explanation, decision.state, decision.action, ...decision.warnings];
      for (const value of strings) {
        // A failure here names the scenario that leaked, which is the whole point of the loop.
        expect(`${decision.state}: ${value}`).not.toMatch(WORKER_UNSAFE);
      }
    }
  });

  it("keeps the worker/adviser summary line free of raw identifiers", () => {
    const line = describeWorkerAndAdviser(
      { workerProviderId: "ollama", workerModelId: "qwen3-coder", openAiSignInAvailable: true },
      { accountLabel: "a***@example.com", planHint: "plus" },
    );
    expect(line).not.toMatch(WORKER_UNSAFE);
  });

  it("keeps account material out of a browser-source listing", async () => {
    const chromeDir = "/home/ada/.config/google-chrome";
    const localState = JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Ada Lovelace", email: "ada.lovelace@example.com", gaia_id: "1234567890123456789012" },
          "Profile 1": { email: "grace.hopper@navy.mil", gaia_id: "9876543210987654321098" },
        },
      },
      os_crypt: { encrypted_key: "QVRMRTpiYW5nZWQ6ZmFrZQ==" },
    });
    const fileSystem: BrowserStateSourceFileSystem = {
      readFile: (path) =>
        path.endsWith("Local State") ? Promise.resolve(localState) : Promise.reject(new Error("no such file")),
      readdir: (path) =>
        path === chromeDir ? Promise.resolve(["Default", "Profile 1"]) : Promise.reject(new Error("no such dir")),
      statExists: (path) => Promise.resolve(path === chromeDir),
      readlinkExists: () => Promise.resolve(false),
    };

    // The listing legitimately names browser directories, so `WORKER_UNSAFE` is not the right pattern
    // here; what must not appear is account material, which is what a profile picker displays and what
    // an accident then logs.
    const sources = await detectBrowserStateSources({ os: "linux", homeDir: "/home/ada", fileSystem });
    const rendered = JSON.stringify(sources);
    expect(rendered).not.toMatch(PERSONAL_DATA);
    expect(rendered).not.toContain("QVRMRTpiYW5nZWQ");
  });

  it("names a running-browser refusal as a reason, not as a source path dump", () => {
    const plan = planChromeStateImport({
      profile: {
        kind: "extension-owned",
        profileId: "chatgpt-adviser",
        userDataDir: "/home/user/.pi/agent/pi-with-chatgpt/browser/chatgpt-profile",
        stateRoot: "/home/user/.pi/agent",
      },
      sourceUserDataDir: "/home/user/.config/google-chrome",
      sourceProfileDirectoryName: "Default",
      existingSourceFiles: new Set(["Network/Cookies", "Local State"]),
      sourceBrowserRunning: true,
      existingDestinationFiles: new Set(),
    });
    if (plan.ok) throw new Error("expected a refusal for a running browser");
    expect(plan.failure).toBe("source-browser-running");
    expect(plan.detail).toMatch(/close|running/iu);
    expect(plan.detail).not.toMatch(WORKER_UNSAFE);
  });
});
