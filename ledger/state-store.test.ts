import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  acquireStateLock,
  appendJsonLine,
  ensurePrivateDirectory,
  lockFilePath,
  nodeStateStore,
  readJsonFile,
  writeJsonFileAtomically,
  StateStoreError,
} from "./state-store.js";

async function workspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pwc-store-${prefix}-`));
}

/** The shape parser stands in for a module's schema check. */
function parseObject(raw: unknown): { value: number } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = (raw as { value?: unknown }).value;
  return typeof value === "number" ? { value } : undefined;
}

describe("state store (INV-15)", () => {
  it("writes owner-only files and leaves no temporary behind", async () => {
    const dir = await workspace("write");
    const path = join(dir, "projects.json");
    await writeJsonFileAtomically(path, { value: 1 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ value: 1 });
    const { readdir } = await import("node:fs/promises");
    // A leftover `.tmp` is a crash fingerprint and, worse, a second copy of the same state.
    expect(await readdir(dir)).toEqual(["projects.json"]);
    const { stat } = await import("node:fs/promises");
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
  });

  it("creates state directories owner-only and refuses a shared one", async () => {
    const dir = await workspace("dir");
    const target = join(dir, "conversations");
    await ensurePrivateDirectory(target);
    const { stat } = await import("node:fs/promises");
    expect(((await stat(target)).mode & 0o777).toString(8)).toBe("700");

    const shared = join(dir, "shared");
    await mkdir(shared);
    await chmod(shared, 0o755);
    await expect(ensurePrivateDirectory(shared)).rejects.toThrow(/owner-only/u);
  });

  it("reports corrupt JSON rather than starting from an empty store", async () => {
    const dir = await workspace("corrupt");
    const path = join(dir, "projects.json");
    await writeFile(path, "{ this is not json", "utf8");
    const result = await readJsonFile(path, parseObject);
    // Silently treating corruption as "no Projects yet" would recreate a Project that already exists.
    expect(result).toEqual({ ok: false, code: "state-corrupt", path });
  });

  it("rejects a file whose shape parser refuses", async () => {
    const dir = await workspace("shape");
    const path = join(dir, "projects.json");
    await writeFile(path, JSON.stringify({ value: "one" }), "utf8");
    expect(await readJsonFile(path, parseObject)).toMatchObject({ ok: false, code: "state-corrupt" });
  });

  it("reads an absent file as undefined and a symlink as corruption", async () => {
    const dir = await workspace("absent");
    expect(await readJsonFile(join(dir, "missing.json"), parseObject)).toEqual({
      ok: true,
      value: undefined,
    });
    const target = join(dir, "elsewhere.json");
    await writeFile(target, JSON.stringify({ value: 1 }), "utf8");
    const link = join(dir, "projects.json");
    await symlink(target, link);
    expect(await readJsonFile(link, parseObject)).toMatchObject({ ok: false, code: "state-corrupt" });
    await expect(writeJsonFileAtomically(link, { value: 2 })).rejects.toBeInstanceOf(StateStoreError);
    // The refusal must not have followed the link.
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ value: 1 });
  });

  it("never lets two callers hold the same lock", async () => {
    const dir = await workspace("lock");
    const path = lockFilePath(dir, "projects");
    const first = await acquireStateLock({ path });
    const started = Date.now();
    await expect(
      acquireStateLock({ path, timeoutMs: 120, pollMs: 10, staleAfterMs: 60_000 }),
    ).rejects.toMatchObject({ code: "state-busy" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await first.release();
    const second = await acquireStateLock({ path, timeoutMs: 500 });
    expect(second.path).toBe(path);
    await second.release();
  });

  it("breaks a lock left behind by a crashed process", async () => {
    const dir = await workspace("stale");
    const path = join(dir, "stale.lock");
    await writeFile(path, "{}\n", "utf8");
    const ancient = new Date(Date.now() - 600_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(path, ancient, ancient);
    const lock = await acquireStateLock({ path, staleAfterMs: 60_000, timeoutMs: 500 });
    expect(lock.path).toBe(path);
    await lock.release();
  });

  it("appends JSONL records one per line", async () => {
    const dir = await workspace("append");
    const path = join(dir, "consultations.jsonl");
    await appendJsonLine(path, { id: "adv-1" });
    await appendJsonLine(path, { id: "adv-2" });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toEqual(['{"id":"adv-1"}', '{"id":"adv-2"}']);
    const { stat } = await import("node:fs/promises");
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
  });

  it("keeps the injected filesystem small enough to fake", async () => {
    const written: { path: string; data: string }[] = [];
    const fake = {
      ...nodeStateStore,
      writeFilePrivate: (path: string, data: string) => {
        written.push({ path, data });
        return Promise.resolve();
      },
      rename: () => Promise.resolve(),
    };
    await writeJsonFileAtomically("/tmp/whatever.json", { value: 3 }, fake);
    // Atomic replacement is a temp write plus a rename; a caller that fakes both can test the layer above
    // the filesystem without touching it.
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.data)).toEqual({ value: 3 });
  });
});
