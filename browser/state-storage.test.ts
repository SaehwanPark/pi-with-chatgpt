import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isLikelyUserBrowserProfile } from "./profile.js";
import {
  adviserProfileFor,
  assertPrivateDirectory,
  modeGrantsAccessToOthers,
  prepareStateStorage,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  stateStoragePaths,
  STATE_GITIGNORE,
  STATE_OWNER_MARKER,
  StateStorageError,
  writePrivateFileNoFollow,
  type StateStorageFileSystem,
} from "./state-storage.js";

interface Recorded {
  dirs: { path: string; mode: number }[];
  chmods: { path: string; mode: number }[];
  files: { path: string; content: string; mode: number }[];
}

interface FakeOptions {
  /** Paths that already exist before the module touches anything. */
  readonly existing?: readonly string[];
  /** Modes to report for paths the fake claims exist (default: already private). */
  readonly modes?: Readonly<Record<string, number>>;
}

function fakeFileSystem(options: FakeOptions = {}): { fs: StateStorageFileSystem; log: Recorded } {
  const log: Recorded = { dirs: [], chmods: [], files: [] };
  const existing = new Set(options.existing ?? []);
  return {
    log,
    fs: {
      mkdir: (path, opts) => (log.dirs.push({ path, mode: opts.mode }), Promise.resolve()),
      chmod: (path, mode) => {
        log.chmods.push({ path, mode });
        existing.add(path);
        return Promise.resolve();
      },
      writePrivateFile: (path, content, mode) => {
        log.files.push({ path, content, mode });
        existing.add(path);
        return Promise.resolve();
      },
      directoryMode: (path) => {
        if (!existing.has(path)) return Promise.resolve(undefined);
        return Promise.resolve(options.modes?.[path] ?? PRIVATE_DIR_MODE);
      },
      pathExists: (path) => Promise.resolve(existing.has(path)),
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

  it("refuses to adopt a pre-existing tree that has no ownership marker", async () => {
    const paths = stateStoragePaths({}, "/home/ada");
    const { fs, log } = fakeFileSystem({ existing: [paths.browserRoot] });

    await expect(prepareStateStorage(paths, fs)).rejects.toMatchObject({
      reason: "state-tree-not-owned",
      name: "StateStorageError",
    });
    // Refusing must be side-effect free: a refusal that chmods or writes first has already claimed
    // the directory, which is the behaviour the guard exists to prevent.
    expect(log.chmods).toHaveLength(0);
    expect(log.dirs).toHaveLength(0);
    expect(log.files).toHaveLength(0);
  });

  it("adopts a pre-existing tree when the ownership marker proves we made it", async () => {
    const paths = stateStoragePaths({}, "/home/ada");
    const { fs, log } = fakeFileSystem({
      existing: [paths.stateRoot, paths.browserRoot, join(paths.browserRoot, STATE_OWNER_MARKER)],
    });

    const prepared = await prepareStateStorage(paths, fs);
    expect(prepared.preexisting).toContain(paths.browserRoot);
    expect(log.files.some((file) => file.path.endsWith(STATE_OWNER_MARKER))).toBe(true);
  });

  it("never changes the mode of a directory it did not create", async () => {
    // stateRoot is Pi's own ~/.pi/agent: pre-existing, and Pi's to permission. Chmod-ing it would be
    // an unrequested write into another program's directory.
    const paths = stateStoragePaths({}, "/home/ada");
    const { fs, log } = fakeFileSystem({
      existing: [paths.stateRoot, paths.browserRoot, join(paths.browserRoot, STATE_OWNER_MARKER)],
      modes: { [paths.stateRoot]: 0o755 },
    });

    await prepareStateStorage(paths, fs);
    expect(log.chmods.map((entry) => entry.path)).not.toContain(paths.stateRoot);
  });

  it("refuses a state directory that is readable by other accounts", async () => {
    const paths = stateStoragePaths({}, "/home/ada");
    const { fs } = fakeFileSystem({ modes: { [paths.profileDir]: 0o755 } });

    await expect(prepareStateStorage(paths, fs)).rejects.toMatchObject({ reason: "directory-not-private" });
  });

  it("is idempotent — a second run adopts the tree it created", async () => {
    const paths = stateStoragePaths({}, "/home/ada");
    const first = fakeFileSystem();
    await prepareStateStorage(paths, first.fs);
    const second = fakeFileSystem({
      existing: [
        paths.stateRoot,
        paths.browserRoot,
        paths.profileDir,
        paths.chromeImportDir,
        join(paths.browserRoot, STATE_OWNER_MARKER),
      ],
    });
    const prepared = await prepareStateStorage(paths, second.fs);
    expect(prepared.created).toEqual([]);
  });
});

describe("writePrivateFileNoFollow", () => {
  const cleanup: string[] = [];

  async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pwc-state-"));
    cleanup.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of cleanup.splice(0, cleanup.length)) await rm(dir, { recursive: true, force: true });
  });

  // The guard lives in a syscall, so it is tested against a real filesystem: a fake can only encode
  // the author's model of `open`, which is exactly how an unimplemented guard survives review.
  it("writes owner-only regardless of the process umask", async () => {
    const dir = await scratch();
    const path = join(dir, "capability.json");
    await writePrivateFileNoFollow(path, "{}", PRIVATE_FILE_MODE);

    const { stat } = await import("node:fs/promises");
    expect((await stat(path)).mode & 0o777).toBe(PRIVATE_FILE_MODE);
    expect(await readFile(path, "utf8")).toBe("{}");
  });

  it("refuses a planted symlink instead of writing through it", async () => {
    const dir = await scratch();
    const victim = join(dir, "victim");
    const link = join(dir, "capability.json");
    await writeFile(victim, "do-not-clobber", { mode: 0o600 });
    await symlink(victim, link);

    await expect(writePrivateFileNoFollow(link, "cookies", PRIVATE_FILE_MODE)).rejects.toMatchObject({
      reason: "symlink-refused",
      name: "StateStorageError",
    });
    expect(await readFile(victim, "utf8")).toBe("do-not-clobber");
  });

  it("replaces a private file it wrote earlier without following a symlink", async () => {
    const dir = await scratch();
    const path = join(dir, "capability.json");
    await writePrivateFileNoFollow(path, "first", PRIVATE_FILE_MODE);
    await writePrivateFileNoFollow(path, "second", PRIVATE_FILE_MODE);
    expect(await readFile(path, "utf8")).toBe("second");
  });

  it("survives the second run against a real tree", async () => {
    const dir = await scratch();
    const paths = stateStoragePaths({ PI_CODING_AGENT_DIR: dir }, "/home/ada");
    await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });

    const first = await prepareStateStorage(paths);
    const second = await prepareStateStorage(paths);
    expect(second.preexisting).toContain(paths.browserRoot);
    expect(await readFile(join(paths.browserRoot, ".gitignore"), "utf8")).toBe(STATE_GITIGNORE);
    expect(first.created.length).toBeGreaterThan(0);
  });

  it("refuses a real pre-existing tree with no marker", async () => {
    const dir = await scratch();
    const paths = stateStoragePaths({ PI_CODING_AGENT_DIR: dir }, "/home/ada");
    await mkdir(paths.browserRoot, { recursive: true, mode: 0o700 });

    await expect(prepareStateStorage(paths)).rejects.toBeInstanceOf(StateStorageError);
  });
});

describe("assertPrivateDirectory", () => {
  it("refuses a directory other accounts can read", async () => {
    await expect(assertPrivateDirectory("/home/ada/profile", { directoryMode: () => Promise.resolve(0o755) }))
      .rejects.toMatchObject({ reason: "directory-not-private" });
  });

  it("accepts an owner-only directory and one it cannot stat", async () => {
    await expect(assertPrivateDirectory("/home/ada/profile", { directoryMode: () => Promise.resolve(0o700) }))
      .resolves.toBeUndefined();
    await expect(assertPrivateDirectory("/home/ada/profile", { directoryMode: () => Promise.resolve(undefined) }))
      .resolves.toBeUndefined();
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
