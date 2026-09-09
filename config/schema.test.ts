import { describe, expect, it } from "vitest";

import { ConfigError, DEFAULT_CONFIG, parseAdviserConfig } from "./schema.js";

describe("configuration safety (INV-07, INV-11, INV-12, INV-16)", () => {
  it("defaults to advisory, synchronous, enabled, with no auto-consultation", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      provider: "chatgpt",
      enabled: true,
      dependencyDefault: "advisory",
      defaultMode: "sync",
      autoConsult: { enabled: false, confirmBeforeDispatch: true },
    });
    expect(parseAdviserConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it.each([
    ["cookie", "session=abc"],
    ["accessToken", "eyJhbGciOi..."],
    ["browserProfile", "/home/dev/.config/google-chrome"],
    ["userDataDir", "/home/dev/.config/google-chrome"],
    ["apiKey", "sk-abcdef0123456789"],
  ] as const)("rejects the credential-shaped key %s instead of ignoring it", (key, value) => {
    expect(() => parseAdviserConfig({ [key]: value })).toThrow(/authentication lives in the extension-owned browser profile/u);
  });

  it("rejects unknown options so typos cannot hide behind defaults", () => {
    expect(() => parseAdviserConfig({ dependnecyDefault: "required" })).toThrow(ConfigError);
  });

  it("accepts the documented options", () => {
    const config = parseAdviserConfig({
      dependencyDefault: "required",
      defaultMode: "async",
      syncTimeoutMs: 60_000,
      pollIntervalMs: 10_000,
      logLevel: "verbose",
      autoConsult: { enabled: true, confirmBeforeDispatch: false },
      browserExecutablePath: "/usr/bin/google-chrome",
    });
    expect(config.dependencyDefault).toBe("required");
    expect(config.defaultMode).toBe("async");
    expect(config.autoConsult).toEqual({ enabled: true, confirmBeforeDispatch: false });
  });

  it("keeps a second provider out of reach of configuration", () => {
    expect(() => parseAdviserConfig({ provider: "claude" })).toThrow(/provider must be "chatgpt"/u);
  });

  it("validates ranges and types", () => {
    expect(() => parseAdviserConfig({ syncTimeoutMs: 10 })).toThrow(/between 5000 and/u);
    expect(() => parseAdviserConfig({ enabled: "yes" })).toThrow(/must be a boolean/u);
    expect(() => parseAdviserConfig({ logLevel: "trace" })).toThrow(/logLevel/u);
    expect(() => parseAdviserConfig({ autoConsult: true })).toThrow(/autoConsult must be an object/u);
  });

  it("gives project-scope configuration no runtime authority", () => {
    // A cloned repository must not be able to redirect the browser binary or enable dispatches.
    expect(() => parseAdviserConfig({ browserExecutablePath: "/usr/bin/google-chrome" }, "project")).toThrow(
      /may only be set globally/u,
    );
    expect(() => parseAdviserConfig({ autoConsult: { enabled: true } }, "project")).toThrow(
      /a project cannot enable auto-consultation/u,
    );
  });

  it("refuses a browser executable that points at the user's profile", () => {
    expect(() =>
      parseAdviserConfig({ browserExecutablePath: "/home/dev/.config/google-chrome/Default" }),
    ).toThrow(/must not point at the user's browser profile/u);
  });
});
