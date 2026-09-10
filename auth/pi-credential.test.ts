import { describe, expect, it } from "vitest";

import {
  defaultPiAuthPath,
  parseStoredCredential,
  readPiOpenAiCredential,
  PI_OPENAI_PROVIDER_ID,
  type PiCredentialAccessor,
} from "./pi-credential.js";

// Obviously synthetic material: nothing here is or was a live token.
const ACCESS = `${"header"}.${"payload"}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
const REFRESH = "refresh-material-that-must-not-be-returned";
const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";

function authFile(credential: unknown): string {
  return JSON.stringify({ [PI_OPENAI_PROVIDER_ID]: credential });
}

/** Simulate `import()` of Pi failing, which is the only supported reason to read the file. */
function moduleUnavailable(): () => Promise<never> {
  return () => Promise.reject(new Error("cannot find module '@earendil-works/pi-coding-agent'"));
}

describe("readPiOpenAiCredential", () => {
  it("prefers Pi's own accessor over reading the file", async () => {
    const calls: string[] = [];
    const module: PiCredentialAccessor & { readStoredCredential(providerId: string): unknown } = {
      readStoredCredential(providerId: string) {
        calls.push(providerId);
        return { type: "oauth", access: ACCESS, expires: 1_800_000_000_000, accountId: ACCOUNT_ID };
      },
      getAuthPath: () => "/tmp/agent/auth.json",
    };

    const read = await readPiOpenAiCredential({ loadPiModule: () => Promise.resolve(module) });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.via).toBe("pi-api");
    expect(calls).toEqual([PI_OPENAI_PROVIDER_ID]);
    expect(read.credential?.kind).toBe("oauth");
  });

  it("reads the named file when a path is given, even with a live Pi accessor", async () => {
    // The accessor does not treat its second argument as a file path, so honouring an override through
    // it would return the default account while claiming to have read the file that was named.
    const module: PiCredentialAccessor = {
      readStoredCredential: () => ({ type: "oauth", access: "wrong-account", expires: 1, accountId: "default" }),
    };
    const read = await readPiOpenAiCredential({
      authPath: "/tmp/elsewhere/auth.json",
      loadPiModule: () => Promise.resolve(module),
      readFile: () => Promise.resolve(authFile({ type: "oauth", access: ACCESS, expires: 1_800_000_000_000, accountId: ACCOUNT_ID })),
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.via).toBe("auth-file");
    expect(read.credential?.kind === "oauth" ? read.credential.accountId : undefined).toBe(ACCOUNT_ID);
  });

  it("reports no credential as an ordinary absence, not a failure", async () => {
    const module: PiCredentialAccessor = { readStoredCredential: () => undefined };
    const read = await readPiOpenAiCredential({ loadPiModule: () => Promise.resolve(module) });
    expect(read).toEqual({ ok: true, credential: undefined, via: "pi-api" });
  });

  it("falls back to a read-only parse of auth.json when Pi is not importable", async () => {
    const read = await readPiOpenAiCredential({
      loadPiModule: moduleUnavailable(),
      authPath: "/tmp/agent/auth.json",
      readFile: () => Promise.resolve(
        authFile({ type: "oauth", access: ACCESS, refresh: REFRESH, expires: 1_800_000_000_000, accountId: ACCOUNT_ID })),
    });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.via).toBe("auth-file");
    expect(read.credential?.kind).toBe("oauth");
    if (read.credential?.kind !== "oauth") return;
    expect(read.credential.accountId).toBe(ACCOUNT_ID);
    expect(read.credential.expiresAt).toBe(1_800_000_000_000);
  });

  it("never carries the refresh token out of the reader", async () => {
    const read = await readPiOpenAiCredential({
      loadPiModule: moduleUnavailable(),
      readFile: () => Promise.resolve(
        authFile({ type: "oauth", access: ACCESS, refresh: REFRESH, expires: 1_800_000_000_000 })),
    });
    expect(read.ok).toBe(true);
    if (!read.ok || read.credential?.kind !== "oauth") throw new Error("expected an oauth credential");
    // The type has no refresh field, and serialisation cannot invent one either.
    expect(JSON.stringify(read)).not.toContain(REFRESH);
    expect(JSON.stringify(read.credential.accessToken)).toBe('"[redacted]"');
  });

  it("distinguishes a missing file from an unreadable one and from malformed JSON", async () => {
    const missing = await readPiOpenAiCredential({
      loadPiModule: moduleUnavailable(),
      readFile: () => Promise.reject(Object.assign(new Error("nope"), { code: "ENOENT" })),
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    // With no Pi module either, "no auth.json anywhere" is the honest statement.
    expect(missing.failure).toBe("pi-package-unavailable");

    const malformed = await readPiOpenAiCredential({
      loadPiModule: moduleUnavailable(),
      readFile: () => Promise.resolve("{ not json"),
    });
    if (malformed.ok) throw new Error("expected malformed auth.json to be refused");
    expect(malformed.failure).toBe("auth-file-malformed");

    const unreadable = await readPiOpenAiCredential({
      loadPiModule: moduleUnavailable(),
      readFile: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })),
    });
    if (unreadable.ok) throw new Error("expected an unreadable auth.json to be reported");
    expect(unreadable.failure).toBe("auth-file-unreadable");
  });

  it("reports an explicitly-named missing file as missing, not unparsable", async () => {
    // Regression: with an explicit authPath the Pi package is never consulted, so its availability is
    // irrelevant. A latent bug returned "pi-package-unavailable" (rendered as "unparsable") whenever the
    // caller named a file that did not exist and Pi was absent from the import path — telling the user to
    // re-run sign-in for what was simply a wrong path.
    const read = await readPiOpenAiCredential({
      authPath: "/definitely/absent/auth.json",
      loadPiModule: moduleUnavailable(),
      readFile: () => Promise.reject(Object.assign(new Error("nope"), { code: "ENOENT" })),
    });
    if (read.ok) throw new Error("expected a missing explicit file to fail");
    expect(read.failure).toBe("auth-file-missing");
  });

  it("refuses a credential shape it does not recognise instead of guessing", async () => {
    const read = await readPiOpenAiCredential({
      loadPiModule: moduleUnavailable(),
      readFile: () => Promise.resolve(authFile({ type: "sso-ticket", ticket: "x" })),
    });
    if (read.ok) throw new Error("expected an unknown credential shape to be refused");
    expect(read.failure).toBe("credential-shape-unrecognised");
  });

  it("drops an api key backed by a command rather than executing it", () => {
    // `key: "!command"` is resolved by Pi at the transport layer. Running it here would execute
    // arbitrary configured programs from a config file, so the credential is treated as unusable.
    expect(parseStoredCredential({ type: "api_key", key: "!secret-helper" })).toBeUndefined();
  });
});

describe("defaultPiAuthPath", () => {
  it("honours the agent-directory override and defaults to ~/.pi/agent", () => {
    expect(defaultPiAuthPath({ PI_CODING_AGENT_DIR: "/tmp/agent" })).toBe("/tmp/agent/auth.json");
    expect(defaultPiAuthPath({})).toBe(`${process.env["HOME"]}/.pi/agent/auth.json`);
  });
});
