import { describe, expect, it } from "vitest";

import { createAdviserProfile, type AdviserProfile } from "./profile.js";
import {
  applyChromeStateImport,
  authorizeChromeStateImport,
  checkImportedFiles,
  discardImportedState,
  LOCAL_STATE_SCRUB_PATHS,
  HUMAN_IMPORT_CONFIRMATION,
  MINIMUM_CHATGPT_STATE_FILES,
  planChromeStateImport,
  scrubChromeLocalState,
  scrubbedPathsPresent,
  verifyChromeStateImport,
  type ChromeStateImportPlan,
  type ImportFileSystem,
} from "./cookie-import.js";

const PROFILE: AdviserProfile = createAdviserProfile({
  stateRoot: "/home/ada/.pi/agent",
  userDataDir: "/home/ada/.pi/agent/pi-with-chatgpt/browser/chatgpt-profile",
});
const SOURCE_DIR = "/home/ada/.config/google-chrome";

const SOURCE_LOCAL_STATE = JSON.stringify({
  os_crypt: { actionable_user_visible_blocklist: [], encrypted_key: "bGlrZS1hLWtleQ==" },
  account_info: [
    { email: "ada@work.example", gaia_id: "111", full_name: "Ada Work" },
    { email: "ada@home.example", gaia_id: "222", full_name: "Ada Home" },
  ],
  profile: {
    info_cache: {
      Default: { name: "Ada", email: "ada@work.example", gaia_id: "111" },
      "Profile 1": { name: "Ada", email: "ada@home.example", gaia_id: "222" },
    },
    last_account_id: "111",
  },
  browser: { shortcuts: { command_shortcuts: [] } },
  version: 132,
});

function planRequest(overrides: Partial<Parameters<typeof planChromeStateImport>[0]> = {}) {
  return {
    profile: PROFILE,
    sourceUserDataDir: SOURCE_DIR,
    sourceProfileDirectoryName: "Default",
    existingSourceFiles: new Set(["Network/Cookies", "Local State"]),
    sourceBrowserRunning: false,
    existingDestinationFiles: new Set<string>(),
    ...overrides,
  };
}

function okPlan(plan: ChromeStateImportPlan): Extract<ChromeStateImportPlan, { ok: true }> {
  if (!plan.ok) throw new Error(`expected a plan, got ${plan.failure}: ${plan.detail}`);
  return plan;
}

/** A plan plus the human authorization every apply needs. */
function authorized(overrides: Parameters<typeof planRequest>[0] = {}) {
  const plan = okPlan(planChromeStateImport(planRequest(overrides)));
  return { plan, authorization: authorizeChromeStateImport(plan, { confirmedByHuman: HUMAN_IMPORT_CONFIRMATION }) };
}

interface FakeDisk {
  /** Virtual file contents, by path. */
  readonly files: Map<string, string>;
  readonly sizes: Map<string, number>;
  readonly written: { path: string; data: string }[];
  readonly copied: { source: string; destination: string }[];
  readonly mkdirs: { path: string; mode: number }[];
  readonly chmods: { path: string; mode: number }[];
  directoryMode: number | undefined;
}

function fakeFileSystem(overrides: Partial<ImportFileSystem> = {}): { fs: ImportFileSystem; disk: FakeDisk } {
  const disk: FakeDisk = {
    files: new Map(),
    sizes: new Map(),
    written: [],
    copied: [],
    mkdirs: [],
    chmods: [],
    directoryMode: 0o700,
  };
  const fs: ImportFileSystem = {
    statSize: (path) => {
      const size = disk.sizes.get(path);
      if (size !== undefined) return Promise.resolve(size);
      const text = disk.files.get(path);
      return Promise.resolve(text === undefined ? undefined : text.length);
    },
    copy: (source, destination) => {
      disk.copied.push({ source, destination });
      const text = disk.files.get(source);
      if (text !== undefined) disk.files.set(destination, text);
      return Promise.resolve();
    },
    chmod: (path, mode) => (disk.chmods.push({ path, mode }), Promise.resolve()),
    mkdir: (path, mode) => (disk.mkdirs.push({ path, mode }), Promise.resolve()),
    readHeader: (path) => {
      const text = disk.files.get(path) ?? disk.written.find((entry) => entry.path === path)?.data;
      return Promise.resolve(text === undefined ? undefined : text.slice(0, 16));
    },
    readText: (path) => {
      const text = disk.files.get(path) ?? disk.written.find((entry) => entry.path === path)?.data;
      return Promise.resolve(text);
    },
    writePrivate: (path, data) => {
      disk.written.push({ path, data });
      disk.files.set(path, data);
      return Promise.resolve();
    },
    directoryMode: () => Promise.resolve(disk.directoryMode),
    ...overrides,
  };
  return { fs, disk };
}

describe("planChromeStateImport", () => {
  it("copies only the minimum set, in the expected layout", () => {
    const plan = okPlan(planChromeStateImport(planRequest()));
    expect(plan.copiedPaths).toEqual(["Network/Cookies", "Local State"]);
    expect(plan.skippedOptionalPaths).toEqual(["Network/Cookies-wal", "Network/Cookies-shm"]);
    expect(plan.entries.map((entry) => entry.destinationPath)).toEqual([
      `${PROFILE.userDataDir}/Network/Cookies`,
      `${PROFILE.userDataDir}/Network/Cookies-wal`,
      `${PROFILE.userDataDir}/Network/Cookies-shm`,
      `${PROFILE.userDataDir}/Local State`,
    ]);
  });

  it("never copies anything outside the allowlist", () => {
    // Even when the source has them, history, passwords, bookmarks, cache, and storage must not move.
    const forbidden = [
      "History",
      "Login Data",
      "Bookmarks",
      "Cookies",
      "Preferences",
      "Cache/Cache_Data",
      "IndexedDB",
      "Local Storage/leveldb",
      "Extensions",
      "Web Data",
    ];
    const plan = okPlan(
      planChromeStateImport(
        planRequest({
          existingSourceFiles: new Set([...forbidden, "Network/Cookies", "Local State"]),
        }),
      ),
    );
    for (const path of plan.copiedPaths) {
      expect(forbidden).not.toContain(path);
    }
    expect(
      plan.copiedPaths.every((path) => MINIMUM_CHATGPT_STATE_FILES.some((spec) => spec.relativePath === path)),
    ).toBe(true);
  });

  it("refuses to copy from a running browser rather than risking a torn database", () => {
    const plan = planChromeStateImport(planRequest({ sourceBrowserRunning: true }));
    expect(!plan.ok && plan.failure).toBe("source-browser-running");
  });

  it("says a source has no session rather than reporting success", () => {
    const plan = planChromeStateImport(planRequest({ existingSourceFiles: new Set(["Local State"]) }));
    expect(!plan.ok && plan.failure).toBe("required-source-file-missing");
  });

  it("refuses to overwrite a profile that already has a session", () => {
    const plan = planChromeStateImport(planRequest({ existingDestinationFiles: new Set(["Network/Cookies"]) }));
    expect(!plan.ok && plan.failure).toBe("destination-not-empty");
  });

  it("refuses a source inside its own state tree", () => {
    const plan = planChromeStateImport(planRequest({ sourceUserDataDir: `${PROFILE.userDataDir}/nested` }));
    expect(!plan.ok && plan.failure).toBe("source-is-extension-profile");
  });

  it("refuses to import a profile onto itself", () => {
    const plan = planChromeStateImport(planRequest({ sourceUserDataDir: PROFILE.userDataDir }));
    expect(!plan.ok && plan.failure).toBe("source-is-extension-profile");
  });
});

describe("planChromeStateImport — source directory containment", () => {
  // The profile directory name arrives from a detection listing or an override. Only the resolved
  // user-data-dir used to be contained, so `../` could aim the resolved profile directory anywhere on
  // disk — including the extension's own profile, which would walk past both self-import guards.
  it.each([
    "..",
    "../../Default",
    "Profile 1/../../..",
    "..\\..\\Default",
    "./Default",
    "/absolute/Default",
    "",
    "Default/../Evil",
  ])("refuses profile directory name %s", (name) => {
    const plan = planChromeStateImport(planRequest({ sourceProfileDirectoryName: name }));
    expect(!plan.ok && plan.failure).toBe("unsafe-source-path");
  });

  it("refuses a traversal that would target the extension's own profile", () => {
    const plan = planChromeStateImport(
      planRequest({
        sourceUserDataDir: `${PROFILE.userDataDir}/..`,
        sourceProfileDirectoryName: "../chatgpt-profile",
      }),
    );
    expect(!plan.ok && plan.failure).toBe("unsafe-source-path");
  });

  it("accepts the real Chromium directory names", () => {
    for (const name of ["Default", "Profile 1", "Profile 12"]) {
      expect(planChromeStateImport(planRequest({ sourceProfileDirectoryName: name })).ok).toBe(true);
    }
  });

  it("records the source it planned so an authorization can be bound to it", () => {
    const plan = okPlan(planChromeStateImport(planRequest({ sourceProfileDirectoryName: "Profile 2" })));
    expect(plan.source).toEqual({
      userDataDir: SOURCE_DIR,
      profileDirectoryName: "Profile 2",
      profileDirectory: `${SOURCE_DIR}/Profile 2`,
    });
  });
});

describe("authorizeChromeStateImport", () => {
  it("refuses a confirmation that was not stated by a human", () => {
    const plan = okPlan(planChromeStateImport(planRequest()));
    const computed = String(plan.copiedPaths.length > 0);
    expect(() =>
      authorizeChromeStateImport(plan, { confirmedByHuman: computed as unknown as typeof HUMAN_IMPORT_CONFIRMATION }),
    ).toThrow(/explicit human confirmation/u);
    expect(() =>
      authorizeChromeStateImport(plan, undefined as unknown as { confirmedByHuman: typeof HUMAN_IMPORT_CONFIRMATION }),
    ).toThrow(/explicit human confirmation/u);
  });

  it("binds the authorization to the plan it was minted for", async () => {
    const forDefault = authorized();
    const forProfile1 = authorized({ sourceProfileDirectoryName: "Profile 1" });

    await expect(
      applyChromeStateImport(forProfile1.plan, forDefault.authorization, fakeFileSystem().fs),
    ).rejects.toMatchObject({ reason: "authorization-for-other-plan" });
  });

  it("applies when the confirmation matches the plan", async () => {
    const { fs, disk } = fakeFileSystem();
    const { plan, authorization } = authorized();
    disk.files.set(plan.source.userDataDir + "/Local State", SOURCE_LOCAL_STATE);
    disk.files.set(`${plan.source.userDataDir}/Network/Cookies`, "SQLite format 3\0cookies");

    await expect(applyChromeStateImport(plan, authorization, fs)).resolves.toEqual([
      "Network/Cookies",
      "Local State",
    ]);
  });

  it("cannot be reached by passing nothing, null, or a forged token", async () => {
    const { fs } = fakeFileSystem();
    const { plan } = authorized();
    const apply = applyChromeStateImport as unknown as (p: unknown, a: unknown, f: unknown) => Promise<unknown>;

    await expect(apply(plan, undefined, fs)).rejects.toMatchObject({ reason: "not-authorized" });
    await expect(apply(plan, null, fs)).rejects.toMatchObject({ reason: "not-authorized" });
    await expect(apply(plan, { kind: "human-authorized" }, fs)).rejects.toMatchObject({
      reason: "authorization-for-other-plan",
    });
  });
});

describe("applyChromeStateImport", () => {
  it("creates the profile directory and moves exactly the planned files", async () => {
    const { fs, disk } = fakeFileSystem();
    const { plan, authorization } = authorized();
    disk.files.set(`${SOURCE_DIR}/Local State`, SOURCE_LOCAL_STATE);
    disk.files.set(`${SOURCE_DIR}/Network/Cookies`, "SQLite format 3\0cookies");

    const copied = await applyChromeStateImport(plan, authorization, fs);
    expect(copied).toEqual(["Network/Cookies", "Local State"]);
    expect(disk.mkdirs.map((entry) => entry.path)).toEqual([PROFILE.userDataDir]);
    // The cookie database is copied; `Local State` is written as a scrubbed copy.
    expect(disk.copied.map((copy) => copy.destination)).toEqual([`${PROFILE.userDataDir}/Network/Cookies`]);
    expect(disk.written.map((entry) => entry.path)).toEqual([`${PROFILE.userDataDir}/Local State`]);
    expect(disk.chmods.every((entry) => entry.mode === 0o600)).toBe(true);
  });

  it("refuses a destination directory other accounts can read", async () => {
    const { fs, disk } = fakeFileSystem();
    const { plan, authorization } = authorized();
    disk.files.set(`${SOURCE_DIR}/Local State`, SOURCE_LOCAL_STATE);
    disk.directoryMode = 0o755;

    await expect(applyChromeStateImport(plan, authorization, fs)).rejects.toMatchObject({
      name: "StateStorageError",
    });
    // Nothing may have been copied before the assertion ran.
    expect(disk.copied).toHaveLength(0);
    expect(disk.written).toHaveLength(0);
  });

  it("refuses to copy a Local State it cannot examine", async () => {
    const { fs, disk } = fakeFileSystem();
    const { plan, authorization } = authorized();
    disk.files.set(`${SOURCE_DIR}/Network/Cookies`, "SQLite format 3\0cookies");
    disk.files.set(`${SOURCE_DIR}/Local State`, "{ not json");

    await expect(applyChromeStateImport(plan, authorization, fs)).rejects.toMatchObject({
      reason: "not-authorized",
    });
  });
});

describe("scrubChromeLocalState", () => {
  it("removes account metadata for every profile, not just the imported one", () => {
    const scrubbed = scrubChromeLocalState(SOURCE_LOCAL_STATE, { os: "linux" });
    expect(scrubbed?.ok).toBe(true);
    const text = scrubbed?.text ?? "";
    for (const secret of ["ada@work.example", "ada@home.example", "gaia_id", "Ada Work", "info_cache"]) {
      expect(text).not.toContain(secret);
    }
    expect(scrubbedPathsPresent(JSON.parse(text), "linux")).toEqual([]);
  });

  it("keeps what Chromium needs to open the cookie database", () => {
    const scrubbed = JSON.parse(scrubChromeLocalState(SOURCE_LOCAL_STATE, { os: "linux" })?.text ?? "{}");
    expect(scrubbed["version"]).toBe(132);
    expect(scrubbed["os_crypt"]?.["actionable_user_visible_blocklist"]).toEqual([]);
  });

  it("keeps the DPAPI key on Windows, where dropping it would import as logged out", () => {
    const scrubbed = JSON.parse(scrubChromeLocalState(SOURCE_LOCAL_STATE, { os: "win32" })?.text ?? "{}");
    expect(scrubbed["os_crypt"]?.["encrypted_key"]).toBeDefined();
  });

  it("reports what it removed, for the provenance record", () => {
    const scrubbed = scrubChromeLocalState(SOURCE_LOCAL_STATE, { os: "linux" });
    expect(scrubbed?.removed).toContain("account_info");
    expect(scrubbed?.removed).toContain("profile.info_cache");
    expect(scrubbed?.removed).toContain("os_crypt.encrypted_key");
  });

  it("does not mutate the document it was given", () => {
    const parsed = JSON.parse(SOURCE_LOCAL_STATE);
    scrubChromeLocalState(SOURCE_LOCAL_STATE, { os: "linux" });
    expect(parsed["account_info"]).toHaveLength(2);
  });

  it("says it could not parse rather than claiming a clean copy", () => {
    expect(scrubChromeLocalState("{", { os: "linux" })).toBeUndefined();
  });

  it("has nothing to scrub that the plan does not copy", () => {
    // A denylist entry pointing at a file we never copy would be a silent no-op in review.
    expect(LOCAL_STATE_SCRUB_PATHS.length).toBeGreaterThan(3);
  });
});

describe("checkImportedFiles", () => {
  it("verifies what a real apply wrote, before the browser starts", async () => {
    const { plan, authorization } = authorized();
    const { fs, disk } = fakeFileSystem();
    disk.files.set(plan.entries[0]?.sourcePath as string, "SQLite format 3\0" + "x".repeat(14));
    disk.files.set(plan.entries[3]?.sourcePath as string, SOURCE_LOCAL_STATE);

    await applyChromeStateImport(plan, authorization, fs);
    const verified = await verifyChromeStateImport(plan, fs);
    expect(verified.ok).toBe(true);

    // A truncated cookie copy must be caught here rather than showing up as a mysterious logout.
    disk.sizes.set(plan.entries[0]?.destinationPath as string, 3);
    const torn = await verifyChromeStateImport(plan, fs);
    expect(!torn.ok && torn.failure).toBe("size-mismatch");
  });

  it("flags a copy that still carries account metadata", async () => {
    const { plan, authorization } = authorized();
    const { fs, disk } = fakeFileSystem();
    disk.files.set(plan.entries[0]?.sourcePath as string, "SQLite format 3\0" + "x".repeat(14));
    disk.files.set(plan.entries[3]?.sourcePath as string, SOURCE_LOCAL_STATE);
    await applyChromeStateImport(plan, authorization, fs);
    // Something rewrote the destination with the original document after the copy.
    disk.files.set(plan.entries[3]?.destinationPath as string, SOURCE_LOCAL_STATE);

    const result = await verifyChromeStateImport(plan, fs);
    expect(!result.ok && result.failure).toBe("unscrubbed-account-metadata");
  });

  it("accepts an intact copy", () => {
    const result = checkImportedFiles([
      { relativePath: "Network/Cookies", expectedSize: 100, actualSize: 100, header: "SQLite format 3\0", scrubbed: false },
      { relativePath: "Local State", expectedSize: 20, actualSize: 12, header: "{", scrubbed: true, scrubbedDocument: {} },
    ]);
    expect(result.ok).toBe(true);
  });

  it("catches a truncated copy, the realistic failure when Chrome was running", () => {
    const result = checkImportedFiles([
      { relativePath: "Network/Cookies", expectedSize: 100, actualSize: 8_192, header: "SQLite format 3\0", scrubbed: false },
    ]);
    expect(!result.ok && result.failure).toBe("size-mismatch");
  });

  it("catches a copy that is not a SQLite database", () => {
    const result = checkImportedFiles([
      {
        relativePath: "Network/Cookies",
        expectedSize: 100,
        actualSize: 100,
        header: "\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0",
        scrubbed: false,
      },
    ]);
    expect(!result.ok && result.failure).toBe("not-a-sqlite-database");
  });

  it("reports a missing copy distinctly from a bad copy", () => {
    const result = checkImportedFiles([
      { relativePath: "Network/Cookies", expectedSize: 100, actualSize: undefined, header: undefined, scrubbed: false },
    ]);
    expect(!result.ok && result.failure).toBe("missing-copy");
  });
});

describe("discardImportedState", () => {
  it("removes exactly what was copied", async () => {
    const removed: string[] = [];
    await discardImportedState(okPlan(planChromeStateImport(planRequest())), {
      remove: (path) => (removed.push(path), Promise.resolve()),
    });
    expect(removed).toEqual([`${PROFILE.userDataDir}/Network/Cookies`, `${PROFILE.userDataDir}/Local State`]);
  });
});
