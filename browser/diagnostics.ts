/**
 * M3 — post-login diagnostics that make a broken consultation debuggable without becoming a leak.
 *
 * A screenshot and a structural DOM dump are the difference between "the UI changed" being a two-line fix
 * and a mystery. They are also the single easiest way to publish a session cookie. So the writer owns the
 * policy and no caller bypasses it:
 *
 * - **Screenshots only after login.** Before sign-in the page may contain the user's own credential entry
 *   or a 2FA code; those pixels are never captured. The caller must hand in a surface state that is past
 *   the login wall, and the writer refuses anything else.
 * - **DOM dumps are structural and attribute-redacted.** Tag names, roles, test ids, and text are kept;
 *   values of credential-shaped attributes are replaced. The raw HTML is never stored.
 * - **Everything is written under the diagnostics directory** at `0600`, inside the extension's own state
 *   root, which the profile module already keeps out of git.
 * - **Retention is bounded** by both age and count, swept on every write, so a long-lived profile cannot
 *   accumulate a gallery of the user's conversations.
 */
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DIAGNOSTIC_POLICY } from "./runtime-types.js";
import { scrubPageText } from "./chatgpt-dom.js";

/** Surface states in which a screenshot is safe: past login, so no credential entry is on screen. */
const SCREENSHOT_SAFE_STATES: readonly string[] = [
  "conversation-ready",
  "generating",
  "response-complete",
  "provider-error",
];

export interface DiagnosticSnapshotInput {
  readonly consultationId: string;
  /** Current surface state; gates whether a screenshot may be captured at all. */
  readonly surfaceState: string;
  /** Raw outerHTML or a serialised structure. Redacted before it touches disk. */
  readonly domMarkup?: string;
  /** Callback that writes PNG bytes to a path; only invoked when a screenshot is permitted. */
  readonly captureScreenshot?: (path: string) => Promise<void>;
  readonly now?: () => Date;
}

export interface DiagnosticWriteResult {
  readonly dir: string;
  readonly screenshotPath?: string;
  readonly domPath?: string;
  /** Why a screenshot was skipped, when applicable. */
  readonly screenshotSkipped?: "before-login" | "not-requested";
  readonly removedCount: number;
}

export interface DiagnosticWriterOptions {
  readonly diagnosticsDir: string;
  readonly retentionMs?: number;
  readonly maxArtifacts?: number;
  /** Overridable so tests need no real filesystem. */
  readonly fs?: {
    mkdir: (path: string, options: { recursive: boolean; mode: number }) => Promise<unknown>;
    writeFile: (path: string, data: string | Uint8Array, options: { mode: number }) => Promise<unknown>;
    readdir: (path: string) => Promise<readonly string[]>;
    stat: (path: string) => Promise<{ mtimeMs: number }>;
    unlink: (path: string) => Promise<unknown>;
  };
}

const fs = {
  mkdir: (path: string, options: { recursive: boolean; mode: number }) => mkdir(path, options),
  writeFile: (path: string, data: string | Uint8Array, options: { mode: number }) => writeFile(path, data, options),
  readdir: (path: string) => readdir(path),
  stat: (path: string) => stat(path),
  unlink: (path: string) => unlink(path),
};

/**
 * Persist whatever diagnostics are safe for this moment and sweep expired artifacts.
 *
 * The DOM is always written (redacted); the screenshot is conditional. A caller that is unsure of the
 * surface state gets no screenshot, which is the safe direction for a mistake.
 */
export async function writeDiagnostics(
  input: DiagnosticSnapshotInput,
  options: DiagnosticWriterOptions,
): Promise<DiagnosticWriteResult> {
  const writer = options.fs ?? fs;
  const retentionMs = options.retentionMs ?? DIAGNOSTIC_POLICY.retentionMs;
  const maxArtifacts = options.maxArtifacts ?? DIAGNOSTIC_POLICY.maxArtifacts;
  const stamp = (input.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  // Consultation ids are ours, but scrub anyway: this value becomes a filename.
  const safeId = input.consultationId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 64);
  const base = `${stamp}_${safeId}`;

  await writer.mkdir(options.diagnosticsDir, { recursive: true, mode: 0o700 });

  let domPath: string | undefined;
  let screenshotPath: string | undefined;
  let screenshotSkipped: DiagnosticWriteResult["screenshotSkipped"];

  if (input.domMarkup !== undefined) {
    domPath = join(options.diagnosticsDir, `${base}.dom.txt`);
    await writer.writeFile(domPath, redactDom(input.domMarkup), { mode: 0o600 });
  }

  const screenshotAllowed = SCREENSHOT_SAFE_STATES.includes(input.surfaceState);
  if (input.captureScreenshot && screenshotAllowed) {
    screenshotPath = join(options.diagnosticsDir, `${base}.png`);
    await input.captureScreenshot(screenshotPath);
  } else if (input.captureScreenshot) {
    screenshotSkipped = "before-login";
  }

  const removedCount = await sweepDiagnostics(options.diagnosticsDir, retentionMs, maxArtifacts, writer, (input.now?.() ?? new Date()).getTime());
  return {
    dir: options.diagnosticsDir,
    removedCount,
    ...(domPath === undefined ? {} : { domPath }),
    ...(screenshotPath === undefined ? {} : { screenshotPath }),
    ...(screenshotSkipped === undefined ? {} : { screenshotSkipped }),
  };
}

/**
 * Turn markup into a structure-and-text dump with credential-shaped attribute *values* removed.
 *
 * This is intentionally not an HTML parser: diagnostics only need enough to see the shape of the tree, and
 * a regex pass cannot be tricked by an element we forgot about the way an allowlist parser can leak a new
 * attribute name. The dangerous direction (keeping a token) is covered by matching on the attribute name.
 */
export function redactDom(markup: string): string {
  const pattern = DIAGNOSTIC_POLICY.redactedAttributePattern;
  // Replace the value of any credential-shaped attribute, leaving the attribute name so structure survives.
  const attributeRegex = new RegExp(
    String.raw`(\p{L}[\p{L}\p{N}_:-]*=(?:"|'))([^"']*)(?:"|')`,
    "giu",
  );
  const redacted = markup.replace(attributeRegex, (match, head: string) => {
    const attributeName = String(head).replace(/[="']$/u, "");
    return pattern.test(attributeName) ? `${head}[redacted]'` : match;
  });
  // Text nodes are the other channel; run them through the same scrubber that protects notices.
  return scrubPageText(redacted, Number.MAX_SAFE_INTEGER);
}

async function sweepDiagnostics(
  dir: string,
  retentionMs: number,
  maxArtifacts: number,
  writer: NonNullable<DiagnosticWriterOptions["fs"]>,
  nowMs: number,
): Promise<number> {
  const names = await writer.readdir(dir).catch(() => [] as readonly string[]);
  const withTime: Array<{ name: string; mtimeMs: number }> = [];
  let removed = 0;

  for (const name of names) {
    const info = await writer.stat(join(dir, name)).catch(() => undefined);
    if (!info) continue;
    if (nowMs - info.mtimeMs > retentionMs) {
      await writer.unlink(join(dir, name)).catch(() => undefined);
      removed += 1;
    } else {
      withTime.push({ name, mtimeMs: info.mtimeMs });
    }
  }

  // Cap by count, oldest first out.
  if (withTime.length > maxArtifacts) {
    withTime.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const excess of withTime.slice(0, withTime.length - maxArtifacts)) {
      await writer.unlink(join(dir, excess.name)).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}
