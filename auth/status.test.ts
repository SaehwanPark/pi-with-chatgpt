import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AdviserProfile } from "../browser/profile.js";
import { PI_OPENAI_PROVIDER_ID } from "./pi-credential.js";
import { adviserStatus, assertStatusIsRedacted, browserSessionStatus } from "./status.js";

function profileFor(userDataDir: string): AdviserProfile {
  return { kind: "extension-owned", profileId: "chatgpt-adviser", userDataDir, stateRoot: userDataDir } as const;
}

/** A credential file shaped like Pi's, carrying an unmistakable secret to look for in the output. */
async function writeAuthFile(dir: string, accountId: string): Promise<string> {
  const path = join(dir, "auth.json");
  const token = [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        sub: `auth0|${accountId}`,
        "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "pro" },
        "https://api.openai.com/profile": { email: `secret-${accountId}@example.com` },
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
  await writeFile(
    path,
    JSON.stringify({
      [PI_OPENAI_PROVIDER_ID]: { type: "oauth", refresh: "super-secret-refresh", access: token, expires: Date.now() + 3_600_000 },
    }),
    { mode: 0o600 },
  );
  return path;
}

describe("adviserStatus", () => {
  it("reports a credential Pi resolves from its own store as a sign-in", async () => {
    // Regression: the status surface used to hand the reader a file path unconditionally, which asked
    // the filesystem instead of Pi. A user signed in through Pi's store — an environment-variable or
    // keychain-backed credential — was told "missing file, sign in" while the adviser worked fine.
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const status = await adviserStatus(profileFor(join(dir, "profile")), {
      loadPiModule: () =>
        Promise.resolve({
          readStoredCredential: () => ({
            type: "oauth",
            access: "opaque-access-token",
            expires: Date.now() + 3_600_000,
            accountId: "acct-pi-store",
          }),
        }),
    });
    expect(status.openAiSignIn).toMatchObject({ present: true, via: "pi-api", accountIdPrefix: "acct-pi-" });
  });

  it("reports a missing sign-in instead of inventing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const status = await adviserStatus(profileFor(join(dir, "profile")), { piAuthPath: join(dir, "absent.json") });
    expect(status.openAiSignIn).toEqual({ present: false, reason: "missing-file" });
    expect(status.piAuthFile.readable).toBe(false);
  });

  it("reports a sign-in with masked identity only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const authFile = await writeAuthFile(dir, "account-deep-secret");
    const status = await adviserStatus(profileFor(join(dir, "profile")), { piAuthPath: authFile });
    expect(status.piAuthFile).toEqual({ readable: true, mode: "600" });
    if (!status.openAiSignIn.present) throw new Error("expected a sign-in");
    expect(status.openAiSignIn).toMatchObject({ via: "auth-file", accountIdPrefix: "account-", planHint: "pro", expired: false });
    expect(status.openAiSignIn.emailMasked).toBe("s***@example.com");
  });

  it("never serialises a token, a refresh token, or an unmasked email", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const authFile = await writeAuthFile(dir, "account-777");
    const status = await adviserStatus(profileFor(join(dir, "profile")), { piAuthPath: authFile });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("super-secret-refresh");
    expect(serialized).not.toContain("secret-account-777@example.com");
    expect(serialized).not.toContain("eyJ");
    expect(() => assertStatusIsRedacted(status)).not.toThrow();
  });

  it("reports whether this profile has ever been signed in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const authFile = await writeAuthFile(dir, "account-1");
    const profile = profileFor(join(dir, "profile"));
    const before = await adviserStatus(profile, { piAuthPath: authFile });
    expect(before.profile.everSignedInHere).toBe(false);

    await mkdir(profile.userDataDir, { recursive: true, mode: 0o700 });
    await writeFile(join(profile.userDataDir, "SESSION-ESTABLISHED"), "signed in once", { mode: 0o600 });
    const after = await adviserStatus(profile, { piAuthPath: authFile });
    expect(after.profile.exists).toBe(true);
    expect(after.profile.everSignedInHere).toBe(true);
  });

  it("does not infer current ChatGPT browser authentication from Pi OAuth or a history marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const authFile = await writeAuthFile(dir, "account-1");
    const profile = profileFor(join(dir, "profile"));
    await mkdir(profile.userDataDir, { recursive: true, mode: 0o700 });
    await writeFile(join(profile.userDataDir, "SESSION-ESTABLISHED"), "signed in once", { mode: 0o600 });

    const status = await adviserStatus(profile, { piAuthPath: authFile });
    expect(status.openAiSignIn.present).toBe(true);
    expect(status.profile.everSignedInHere).toBe(true);
    expect(status.browserSession).toEqual({ state: "unverified", reason: "probe-required" });
  });

  it("reports a fresh adviser-browser observation without copying identity details", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const authFile = await writeAuthFile(dir, "account-1");
    const profile = profileFor(join(dir, "profile"));
    const status = await adviserStatus(profile, {
      piAuthPath: authFile,
      browserSession: {
        kind: "signed-in",
        identity: { source: "chatgpt-browser", accountIdHint: "browser-account-secret" },
      },
    });
    expect(status.browserSession).toEqual({ state: "signed-in" });
    expect(JSON.stringify(status)).not.toContain("browser-account-secret");
  });

  it("states isolation as a constant rather than as observed data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const status = await adviserStatus(profileFor(join(dir, "profile")), { piAuthPath: join(dir, "absent.json") });
    // If this ever became data-dependent, the profile could stop being ours — that is INV-11, not a detail.
    expect(status.isolation).toEqual({ extensionOwned: true, sharesDefaultChromeProfile: false });
  });
});

describe("browserSessionStatus", () => {
  it("uses an explicit unverified state when no browser probe was supplied", () => {
    expect(browserSessionStatus(undefined)).toEqual({ state: "unverified", reason: "probe-required" });
  });

  it("preserves only safe terminal state and reason values", () => {
    expect(browserSessionStatus({ kind: "human-verification", challenge: "captcha" })).toEqual({
      state: "human-verification",
      challenge: "captcha",
    });
    expect(browserSessionStatus({ kind: "unreachable", reason: "profile-locked" })).toEqual({
      state: "unreachable",
      reason: "profile-locked",
    });
  });
});

describe("assertStatusIsRedacted", () => {
  it("rejects a status that grew a credential-shaped field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const status = await adviserStatus(profileFor(join(dir, "profile")), { piAuthPath: join(dir, "absent.json") });
    const leaked = { ...status, openAiSignIn: { present: false, reason: "io-error", token: "..." } } as unknown as typeof status;
    expect(() => assertStatusIsRedacted(leaked)).toThrow(/credential-shaped/u);
  });

  it("rejects a JWT that arrived under an unexpected key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const status = await adviserStatus(profileFor(join(dir, "profile")), { piAuthPath: join(dir, "absent.json") });
    const leaked = { ...status, profile: { userDataDir: "eyJhbGciOi", exists: false, everSignedInHere: false } } as unknown as typeof status;
    expect(() => assertStatusIsRedacted(leaked)).toThrow(/JWT/u);
  });

  it("does not expose auth or browser filesystem paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwc-status-"));
    const status = await adviserStatus(profileFor(join(dir, "profile")), { piAuthPath: join(dir, "auth.json") });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("userDataDir");
  });
});
