import { describe, expect, it } from "vitest";

import { isLikelyUserBrowserProfile } from "./profile.js";
import {
  adviserProfileFor,
  modeGrantsAccessToOthers,
  prepareStateStorage,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  stateStoragePaths,
  STATE_GITIGNORE,
  STATE_OWNER_MARKER,
  type StateStorageFileSystem,
} from "./state-storage.js";

interface Recorded {
  dirs: { path: string; mode: number }[];
  chmods: { path: string; mode: number }[];
  files: { path: string; content: string; mode: number }[];
}

function fakeFileSystem(): { fs: StateStorageFileSystem; log: Recorded } {
  const log: Recorded = { dirs: [], chmods: [], files: [] };
  return {
    log,
    fs: {
      mkdir: (path, options) => (log.dirs.push({ path, mode: options.mode }), Promise.resolve()),
      chmod: (path, mode) => (log.chmods.push({ path, mode }), Promise.resolve()),
      writeFile: (path, content, options) => (log.files.push({ path, content, mode: options.mode }), Promise.resolve()),
    },
  };
}

describe("stateStoragePaths", () => {
  it("places state under the Pi agent directory, never the workspace", () => {
    const paths = stateStoragePaths({}, "/home/ada");
    expect(paths.browserRoot).toBe("/home/ada/.pi/agent/pi-with-chatgpt/browser");
    expect(paths.profileDir).toBe("/home/ada/.pi/agent/pi-with-chatgpt/browser/chatgpt-profile");
    expect(paths.chromeImportDir).toBe(`${paths.browserRoot}/chrome-imports`);
    expect(paths.capabilityStateFile).toBe(`${paths.browserRoot}/capability.json`);
    expect(paths.profileDir).not.toContain("workspace");
  });

  it("follows the agent-directory override", () => {
    const paths = stateStoragePaths({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/ada");
    expect(paths.stateRoot).toBe("/tmp/agent");
    expect(paths.browserRoot).toBe("/tmp/agent/pi-with-chatgpt/browser");
  });

  it("produces a profile that satisfies the INV-11 ownership check", () => {
    const profile = adviserProfileFor(stateStoragePaths({}, "/home/ada"));
    expect(profile.kind).toBe("extension-owned");
    expect(profile.userDataDir).toBe("/home/ada/.pi/agent/pi-with-chatgpt/browser/chatgpt-profile");
  });

  it("refuses an override that points at the user's own browser", () => {
    // The default profile path can only be rejected if the check is wired into the defaults, so an
    // override pointing inside Chrome's own tree must throw rather than yield a path.
    expect(() => adviserProfileFor(stateStoragePaths({}, "/home/ada/.config/google-chrome"))).toThrow(
      /looks-like-user-browser-profile/u,
    );
  });
});

describe("prepareStateStorage", () => {
  it("creates every directory owner-only and re-asserts the mode", async () => {
    const { fs, log } = fakeFileSystem();
    const paths = stateStoragePaths({}, "/home/ada");
    const prepared = await prepareStateStorage(paths, fs);

    expect(prepared.created).toEqual([
      paths.stateRoot,
      paths.browserRoot,
      paths.profileDir,
      paths.chromeImportDir,
    ]);
    expect(log.dirs.every((entry) => entry.mode === PRIVATE_DIR_MODE)).toBe(true);
    expect(log.chmods).toHaveLength(4);
    expect(log.chmods.every((entry) => entry.mode === PRIVATE_DIR_MODE)).toBe(true);
  });

  it("drops an ownership marker and a self-ignoring .gitignore", async () => {
    const { fs, log } = fakeFileSystem();
    await prepareStateStorage(stateStoragePaths({}, "/home/ada"), fs);
    const marker = log.files.find((file) => file.path.endsWith(STATE_OWNER_MARKER));
    const ignore = log.files.find((file) => file.path.endsWith(".gitignore"));
    expect(marker?.content).toMatch(/pi-with-chatgpt/u);
    expect(marker?.content).toMatch(/cookies/u);
    expect(ignore?.content).toBe(STATE_GITIGNORE);
    expect(log.files.every((file) => file.mode === PRIVATE_FILE_MODE)).toBe(true);
  });
});

describe("adviser profile ownership", () => {
  it("recognises the user's browser directories on every platform", () => {
    for (const path of [
      "/home/ada/.config/google-chrome",
      "/home/ada/.config/google-chrome/Default",
      "/Users/ada/Library/Application Support/Google/Chrome/Profile 1",
      "C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\User Data\\Default",
      "/home/ada/.config/chromium",
      "/home/ada/.config/microsoft-edge",
    ]) {
      expect(isLikelyUserBrowserProfile(path)).toBe(true);
    }
    expect(isLikelyUserBrowserProfile("/home/ada/.pi/agent/pi-with-chatgpt/browser/chatgpt-profile")).toBe(
      false,
    );
  });
});

describe("modeGrantsAccessToOthers", () => {
  it.each([
    [0o700, false],
    [0o755, true],
    [0o770, true],
    [0o600, false],
    [0o644, true],
  ])("flags %o as granting access to others: %s", (mode, expected) => {
    expect(modeGrantsAccessToOthers(mode)).toBe(expected);
  });
});
