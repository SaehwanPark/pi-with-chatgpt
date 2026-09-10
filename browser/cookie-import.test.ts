import { describe, expect, it } from "vitest";

import { createAdviserProfile, type AdviserProfile } from "./profile.js";
import {
  applyChromeStateImport,
  checkImportedFiles,
  discardImportedState,
  MINIMUM_CHATGPT_STATE_FILES,
  planChromeStateImport,
  verifyChromeStateImport,
  type ChromeStateImportPlan,
  type ImportFileSystem,
} from "./cookie-import.js";

const PROFILE: AdviserProfile = createAdviserProfile({
  stateRoot: "/home/ada/.pi/agent",
  userDataDir: "/home/ada/.pi/agent/pi-with-chatgpt/browser/chatgpt-profile",
});
const SOURCE_DIR = "/home/ada/.config/google-chrome";

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
    expect(plan.copiedPaths.every((path) =>
      MINIMUM_CHATGPT_STATE_FILES.some((spec) => spec.relativePath === path),
    )).toBe(true);
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
    const plan = planChromeStateImport(
      planRequest({ existingDestinationFiles: new Set(["Network/Cookies"]) }),
    );
    expect(!plan.ok && plan.failure).toBe("destination-not-empty");
  });

  it("refuses a source inside its own state tree", () => {
    const plan = planChromeStateImport(
      planRequest({ sourceUserDataDir: `${PROFILE.userDataDir}/nested` }),
    );
    expect(!plan.ok && plan.failure).toBe("source-is-extension-profile");
  });

  it("refuses to import a profile onto itself", () => {
    const plan = planChromeStateImport(planRequest({ sourceUserDataDir: PROFILE.userDataDir }));
    expect(!plan.ok && plan.failure).toBe("source-is-extension-profile");
  });
});

describe("applyChromeStateImport", () => {
  it("creates the profile directory and copies exactly the planned files", async () => {
    const copies: { source: string; destination: string }[] = [];
    const fileSystem: ImportFileSystem = {
      statSize: () => Promise.resolve(10),
      copy: (source, destination) => (copies.push({ source, destination }), Promise.resolve()),
      chmod: () => Promise.resolve(),
      mkdir: () => Promise.resolve(),
      readHeader: () => Promise.resolve(undefined),
    };
    const plan = okPlan(planChromeStateImport(planRequest()));
    const copied = await applyChromeStateImport(plan, fileSystem);
    expect(copied).toEqual(["Network/Cookies", "Local State"]);
    expect(copies.map((copy) => copy.destination)).toEqual([
      `${PROFILE.userDataDir}/Network/Cookies`,
      `${PROFILE.userDataDir}/Local State`,
    ]);
  });
});

describe("checkImportedFiles", () => {
  it("verifies a plan against the filesystem before the browser starts", async () => {
    const plan = okPlan(planChromeStateImport(planRequest()));
    // A tiny in-memory filesystem: sizes are what the verifier compares, headers are what they are.
    const disk = new Map<string, { size: number; header?: string }>([
      [plan.entries[0]?.sourcePath as string, { size: 4_096 }],
      [plan.entries[0]?.destinationPath as string, { size: 4_096, header: "SQLite format 3\0" }],
      [plan.entries[3]?.sourcePath as string, { size: 128 }],
      [plan.entries[3]?.destinationPath as string, { size: 128, header: "{" }],
    ]);
    const fileSystem: ImportFileSystem = {
      statSize: (path) => Promise.resolve(disk.get(path)?.size),
      copy: () => Promise.resolve(),
      chmod: () => Promise.resolve(),
      mkdir: () => Promise.resolve(),
      readHeader: (path) => Promise.resolve(disk.get(path)?.header),
    };

    const verified = await verifyChromeStateImport(plan, fileSystem);
    expect(verified.ok).toBe(true);

    // A truncated cookie copy must be caught here rather than showing up as a mysterious logout.
    disk.set(plan.entries[0]?.destinationPath as string, { size: 4_095, header: "SQLite format 3\0" });
    const torn = await verifyChromeStateImport(plan, fileSystem);
    expect(!torn.ok && torn.failure).toBe("size-mismatch");
  });

  it("accepts an intact copy", () => {
    const result = checkImportedFiles([
      { relativePath: "Network/Cookies", expectedSize: 100, actualSize: 100, header: "SQLite format 3\0" },
      { relativePath: "Local State", expectedSize: 20, actualSize: 20, header: "{" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("catches a truncated copy, the realistic failure when Chrome was running", () => {
    const result = checkImportedFiles([
      { relativePath: "Network/Cookies", expectedSize: 100, actualSize: 8_192, header: "SQLite format 3\0" },
    ]);
    expect(!result.ok && result.failure).toBe("size-mismatch");
  });

  it("catches a copy that is not a SQLite database", () => {
    const result = checkImportedFiles([
      { relativePath: "Network/Cookies", expectedSize: 100, actualSize: 100, header: "\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0" },
    ]);
    expect(!result.ok && result.failure).toBe("not-a-sqlite-database");
  });

  it("reports a missing copy distinctly from a bad copy", () => {
    const result = checkImportedFiles([
      { relativePath: "Network/Cookies", expectedSize: 100, actualSize: undefined, header: undefined },
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
    expect(removed).toEqual([
      `${PROFILE.userDataDir}/Network/Cookies`,
      `${PROFILE.userDataDir}/Local State`,
    ]);
  });
});
