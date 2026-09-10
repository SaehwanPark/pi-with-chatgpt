import { describe, expect, it } from "vitest";

import {
  detectBrowserStateSources,
  parseChromeLocalState,
  type BrowserStateSourceFileSystem,
} from "./chrome-state.js";

const LOCAL_STATE = JSON.stringify({
  profile: {
    info_cache: {
      Default: {
        name: "Ada Lovelace",
        user_name: "ada",
        email: "ada@example.com",
        gaia_id: "1234567890123456789012",
        last_used: "13300000000000000",
        // Anything else Chrome stores here must not leak into the reference.
        icon_url: "https://example.invalid/a.png",
      },
      "Profile 1": { name: "Grace Hopper", email: "grace@example.com", gaia_id: "99" },
    },
  },
  os_crypt: { encrypted_key: "QVRMRTpiYW5nZWQ6ZmFrZQ==" },
});

function fakeFs(overrides: {
  dirs?: Record<string, string[]>;
  files?: Record<string, string>;
  exists?: Record<string, boolean>;
  links?: Record<string, boolean>;
  failRead?: string[];
}): BrowserStateSourceFileSystem {
  const dirs = overrides.dirs ?? {};
  const files = overrides.files ?? {};
  const exists = overrides.exists ?? {};
  const links = overrides.links ?? {};
  const failRead = new Set(overrides.failRead ?? []);
  return {
    readFile: (path) =>
      failRead.has(path) || files[path] === undefined
        ? Promise.reject(new Error(`no such file: ${path}`))
        : Promise.resolve(files[path]),
    readdir: (path) =>
      dirs[path] === undefined ? Promise.reject(new Error(`no such dir: ${path}`)) : Promise.resolve(dirs[path]),
    statExists: (path) => Promise.resolve(exists[path] ?? false),
    readlinkExists: (path) => Promise.resolve(links[path] ?? false),
  };
}

const CHROME_DIR = "/home/ada/.config/google-chrome";

/** A `Local State` whose one profile has a name and no identifiers at all. */
const LOCAL_STATE_NO_ACCOUNT = JSON.stringify({ profile: { info_cache: { Default: { name: "Ada" } } } });

describe("detectBrowserStateSources", () => {
  it("finds the Linux Chrome profile and its accounts", async () => {
    const sources = await detectBrowserStateSources({
      os: "linux",
      homeDir: "/home/ada",
      fileSystem: fakeFs({
        exists: { [CHROME_DIR]: true },
        dirs: { [CHROME_DIR]: ["Default", "Profile 1", "Local State", "Crashpad"] },
        files: { [`${CHROME_DIR}/Local State`]: LOCAL_STATE },
      }),
    });

    expect(sources.platform).toBe("linux");
    expect(sources.installs).toHaveLength(1);
    const install = sources.installs[0] as (typeof sources.installs)[number];
    expect(install.family).toBe("chrome");
    expect(install.profiles.map((profile) => profile.directoryName)).toEqual(["Default", "Profile 1"]);

    const first = install.profiles[0] as (typeof install.profiles)[number];
    expect(first.displayName).toBe("Ada Lovelace");
    // The listing is display-only: recognisable, and with no value that could be replayed or logged.
    expect(first.accounts[0]?.emailMasked).toBe("a***@example.com");
    expect(first.accounts[0]?.gaiaIdMasked).toBe("123456…");
    const rendered = JSON.stringify(first);
    expect(rendered).not.toContain("QVRMRTpiYW5nZWQ");
    expect(rendered).not.toContain("ada@example.com");
    expect(rendered).not.toMatch(/"gaia_id"|"email":\s*"ada/u);
  });

  it("reports no account id when Chrome recorded none instead of inventing one", async () => {
    // A fabricated id looks like an identifier and will eventually be compared against another, which
    // is how "same profile" turns into "same account". The profile directory already names the profile.
    const sources = await detectBrowserStateSources({
      os: "linux",
      homeDir: "/home/ada",
      fileSystem: fakeFs({
        exists: { [CHROME_DIR]: true },
        dirs: { [CHROME_DIR]: ["Default"] },
        files: { [`${CHROME_DIR}/Local State`]: LOCAL_STATE_NO_ACCOUNT },
      }),
    });
    const account = sources.installs[0]?.profiles[0]?.accounts[0];
    expect(account).toEqual({ name: "Ada" });
    expect(JSON.stringify(account)).not.toContain("Default");
  });

  it("reports a running browser instead of pretending the profile is free to copy", async () => {
    const sources = await detectBrowserStateSources({
      os: "linux",
      homeDir: "/home/ada",
      fileSystem: fakeFs({
        exists: { [CHROME_DIR]: true },
        dirs: { [CHROME_DIR]: ["Default"] },
        files: { [`${CHROME_DIR}/Local State`]: LOCAL_STATE },
        links: { [`${CHROME_DIR}/SingletonLock`]: true },
      }),
    });
    const profile = sources.installs[0]?.profiles[0];
    expect(profile?.lockedByRunningBrowser).toBe(true);
  });

  it("distinguishes an unreadable Local State from a profile with no accounts", async () => {
    const sources = await detectBrowserStateSources({
      os: "linux",
      homeDir: "/home/ada",
      fileSystem: fakeFs({
        exists: { [CHROME_DIR]: true },
        dirs: { [CHROME_DIR]: ["Default", "Profile 1"] },
        files: {},
        failRead: [`${CHROME_DIR}/Local State`],
      }),
    });
    const profile = sources.installs[0]?.profiles[0];
    // "Cannot read" is reported as unreadable, never collapsed into "zero accounts".
    expect(profile?.stateReadable).toBe(false);
    expect(profile?.rejection).toBe("local-state-missing");
    expect(profile?.accounts).toEqual([]);
  });

  it("returns no installs when the user has no Chromium family browser", async () => {
    const sources = await detectBrowserStateSources({
      os: "linux",
      homeDir: "/home/ada",
      fileSystem: fakeFs({}),
    });
    expect(sources.installs).toEqual([]);
  });

  it("finds nothing on Windows, which is outside the V1 platform claim", async () => {
    // Out of scope must mean "no browser import is offered", not "a guess is made". Manual login and
    // the isolated profile still work there; only Chrome-state discovery is unimplemented.
    const sources = await detectBrowserStateSources({
      os: "win32",
      homeDir: "C:\\Users\\ada",
      fileSystem: fakeFs({ exists: { "C:\\Users\\ada\\AppData": true } }),
    });
    expect(sources.installs).toEqual([]);
  });

  it("ignores directories that are not Chromium profiles", async () => {
    const sources = await detectBrowserStateSources({
      os: "linux",
      homeDir: "/home/ada",
      fileSystem: fakeFs({
        exists: { [CHROME_DIR]: true },
        dirs: { [CHROME_DIR]: ["Default", "Profiles", "Profiles 2", "component_crx_cache"] },
        files: { [`${CHROME_DIR}/Local State`]: LOCAL_STATE },
      }),
    });
    expect(sources.installs[0]?.profiles.map((profile) => profile.directoryName)).toEqual(["Default"]);
  });
});

describe("parseChromeLocalState", () => {
  it("returns undefined for content it cannot parse", () => {
    expect(parseChromeLocalState("{")).toBeUndefined();
    expect(parseChromeLocalState("null")).toBeUndefined();
  });

  it("tolerates a file without an info cache", () => {
    expect(parseChromeLocalState("{}")).toEqual({});
  });

  it("masks every identity field it returns", () => {
    const parsed = parseChromeLocalState(
      JSON.stringify({
        profile: { info_cache: { Default: { email: "ada@example.com", gaia_id: "123456789" } } },
      }),
    );
    expect(parsed?.["Default"]).toEqual({ emailMasked: "a***@example.com", gaiaIdMasked: "123456…" });
  });

  it("hides a short identifier entirely rather than revealing most of it", () => {
    // Prefix-masking a 4-character id would publish almost the whole value; below the recognisable
    // threshold the honest answer is "nothing".
    const parsed = parseChromeLocalState(
      JSON.stringify({ profile: { info_cache: { Default: { gaia_id: "1234" } } } }),
    );
    expect(parsed?.["Default"]).toEqual({ gaiaIdMasked: "***" });
  });
});
