/**
 * Diagnostics policy tests. The interesting assertion is not that files get written — it is that a
 * screenshot is *refused* before login, because that is the one mistake that would publish credentials.
 */
import { describe, expect, it } from "vitest";

import { redactDom, writeDiagnostics } from "./diagnostics.js";

interface FakeFs {
  files: Map<string, string | Uint8Array>;
  modes: Map<string, number>;
  dirs: Set<string>;
  mkdir: (path: string, options: { recursive: boolean; mode: number }) => Promise<unknown>;
  writeFile: (path: string, data: string | Uint8Array, options: { mode: number }) => Promise<unknown>;
  readdir: (path: string) => Promise<readonly string[]>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
  unlink: (path: string) => Promise<unknown>;
  setMtime: (path: string, mtimeMs: number) => void;
}

function fakeFs(initial: Record<string, number> = {}): FakeFs {
  const files = new Map<string, string | Uint8Array>(Object.keys(initial).map((key) => [key, ""]));
  const modes = new Map<string, number>();
  const times = new Map<string, number>(Object.entries(initial).map(([k, v]) => [k, v]));
  const dirs = new Set<string>();
  return {
    files,
    modes,
    dirs,
    setMtime: (path, mtimeMs) => {
      times.set(path, mtimeMs);
      if (!files.has(path)) files.set(path, "");
    },
    mkdir: (path) => {
      dirs.add(path);
      return Promise.resolve();
    },
    writeFile: (path, data, options) => {
      files.set(path, data);
      modes.set(path, options.mode);
      return Promise.resolve();
    },
    readdir: (path) =>
      Promise.resolve([...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => key.slice(path.length + 1))),
    stat: (path) =>
      files.has(path)
        ? Promise.resolve({ mtimeMs: times.get(path) ?? 0 })
        : Promise.reject(new Error(`missing ${path}`)),
    unlink: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
  };
}

const NOW = new Date("2026-07-22T12:00:00.000Z");
const NOW_MS = NOW.getTime();

describe("writeDiagnostics screenshot gate", () => {
  it("refuses a screenshot before login", async () => {
    let captured = false;
    const result = await writeDiagnostics(
      {
        consultationId: "c-1",
        surfaceState: "signed-out",
        captureScreenshot: () => {
          captured = true;
          return Promise.resolve();
        },
        now: () => NOW,
      },
      { diagnosticsDir: "/diag", fs: fakeFs() },
    );
    expect(captured).toBe(false);
    expect(result.screenshotSkipped).toBe("before-login");
    expect(result.screenshotPath).toBeUndefined();
  });

  it("refuses a screenshot on a verification wall", async () => {
    const result = await writeDiagnostics(
      { consultationId: "c-1", surfaceState: "human-verification", captureScreenshot: () => Promise.resolve(), now: () => NOW },
      { diagnosticsDir: "/diag", fs: fakeFs() },
    );
    expect(result.screenshotPath).toBeUndefined();
  });

  it("captures a screenshot once the surface is past login", async () => {
    const result = await writeDiagnostics(
      { consultationId: "c-1", surfaceState: "response-complete", captureScreenshot: () => Promise.resolve(), now: () => NOW },
      { diagnosticsDir: "/diag", fs: fakeFs() },
    );
    expect(result.screenshotPath).toContain(".png");
  });
});

describe("writeDiagnostics file policy", () => {
  it("writes the DOM dump at 0600 inside the diagnostics dir", async () => {
    const fake = fakeFs();
    const result = await writeDiagnostics(
      { consultationId: "c-9", surfaceState: "conversation-ready", domMarkup: "<div>hi</div>", now: () => NOW },
      { diagnosticsDir: "/diag", fs: fake },
    );
    expect(result.domPath?.startsWith("/diag/")).toBe(true);
    expect(fake.modes.get(result.domPath!)).toBe(0o600);
    expect(fake.dirs.has("/diag")).toBe(true);
  });

  it("never escapes the diagnostics directory through a hostile id", async () => {
    const result = await writeDiagnostics(
      { consultationId: "../../etc/passwd", surfaceState: "conversation-ready", domMarkup: "x", now: () => NOW },
      { diagnosticsDir: "/diag", fs: fakeFs() },
    );
    expect(result.domPath?.includes("/etc/passwd")).toBe(false);
  });
});

describe("writeDiagnostics retention", () => {
  it("deletes artifacts older than the retention window", async () => {
    const fake = fakeFs();
    fake.setMtime("/diag/old.png", NOW_MS - 30 * 24 * 60 * 60 * 1000);
    const result = await writeDiagnostics(
      { consultationId: "c-1", surfaceState: "response-complete", now: () => NOW },
      { diagnosticsDir: "/diag", fs: fake, retentionMs: 7 * 24 * 60 * 60 * 1000 },
    );
    expect(fake.files.has("/diag/old.png")).toBe(false);
    expect(result.removedCount).toBe(1);
  });

  it("caps the artifact count, removing the oldest first", async () => {
    const fake = fakeFs();
    for (let index = 0; index < 5; index += 1) {
      fake.setMtime(`/diag/keep-${index}.png`, NOW_MS - (5 - index) * 1000);
    }
    const result = await writeDiagnostics(
      { consultationId: "c-1", surfaceState: "response-complete", now: () => NOW },
      { diagnosticsDir: "/diag", fs: fake, maxArtifacts: 2, retentionMs: Number.MAX_SAFE_INTEGER },
    );
    // Two retained plus the one written now; the sweep keeps the cap, oldest first out.
    expect(result.removedCount).toBeGreaterThanOrEqual(3);
    expect(fake.files.has("/diag/keep-0.png")).toBe(false);
    expect(fake.files.has("/diag/keep-4.png")).toBe(true);
  });
});

describe("redactDom", () => {
  it("removes credential-shaped attribute values but keeps structure", () => {
    const dom = '<input type="text" session-token="abc.def.ghi" data-testid="composer" value="hello"/>';
    const redacted = redactDom(dom);
    expect(redacted).toContain("data-testid");
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("abc.def.ghi");
  });

  it("leaves ordinary attributes readable for debugging", () => {
    const dom = '<button data-testid="send-button" aria-label="Send Prompt">Send</button>';
    expect(redactDom(dom)).toContain("send-button");
  });

  it("scrubs token material that appears as bare text", () => {
    expect(redactDom("notice sk-proj-abcdefghijklmnopqrstuvwxyz more")).not.toContain("sk-proj-abc");
  });
});
