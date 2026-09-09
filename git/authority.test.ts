import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertReadOnlyGitArgs,
  CHECKPOINT_NOT_REMOTE_GUIDANCE,
  FORBIDDEN_GIT_ARG_TOKENS,
  GitAuthorityError,
  isReadOnlyGitInvocation,
  READ_ONLY_GIT_INVOCATIONS,
} from "./authority.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const MODULES = ["extension", "git", "auth", "browser", "chatgpt", "jobs", "protocol", "ledger", "drift", "config", "ui"];

describe("git safety on the consultation path (INV-06)", () => {
  it("permits read-only inspection", () => {
    expect(isReadOnlyGitInvocation(["rev-parse", "HEAD"])).toBe(true);
    expect(isReadOnlyGitInvocation(["branch", "--show-current"])).toBe(true);
    expect(isReadOnlyGitInvocation(["ls-remote", "--tags", "origin"])).toBe(true);
    expect(assertReadOnlyGitArgs(["status", "--porcelain"])).toEqual(["status", "--porcelain"]);
  });

  it("refuses mutation even when the subcommand looks harmless", () => {
    expect(() => assertReadOnlyGitArgs(["add", "-A"])).toThrow(GitAuthorityError);
    expect(() => assertReadOnlyGitArgs(["commit", "-m", "advice"])).toThrow(GitAuthorityError);
    expect(() => assertReadOnlyGitArgs(["push", "origin", "main"])).toThrow(GitAuthorityError);
    expect(() => assertReadOnlyGitArgs(["remote", "set-url", "origin", "git@github.com:evil/repo.git"])).toThrow(
      GitAuthorityError,
    );
    expect(() => assertReadOnlyGitArgs(["branch", "-D", "main"])).toThrow(GitAuthorityError);
    expect(() => assertReadOnlyGitArgs(["worktree", "add", "../x"])).toThrow(GitAuthorityError);
  });

  it("refuses force-push spellings inside an allowed prefix", () => {
    // `git diff -- --force` is not a thing, but a fail-closed guard should not care.
    expect(() => assertReadOnlyGitArgs(["diff", "--force-with-lease"])).toThrow(GitAuthorityError);
  });

  it("keeps the allowlist free of mutating subcommands", () => {
    const mutating = ["add", "commit", "push", "pull", "fetch", "merge", "rebase", "reset", "checkout", "clean", "apply"];
    for (const command of mutating) {
      expect(READ_ONLY_GIT_INVOCATIONS).not.toContain(command);
    }
    // The forbidden list must cover the roadmap's explicit prohibitions.
    for (const token of ["add", "-A", "--all", "commit", "push"]) {
      expect(FORBIDDEN_GIT_ARG_TOKENS).toContain(token);
    }
  });

  it("tells the worker what to do instead of committing for it", () => {
    expect(CHECKPOINT_NOT_REMOTE_GUIDANCE).toContain("will not stage, commit, or push");
  });
});

describe("prohibited-by-construction source scan (INV-01, INV-02, INV-06, INV-11)", () => {
  const sourceFiles = MODULES.flatMap((module) => collectTsFiles(join(repoRoot, module)));

  it("finds TypeScript sources to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(10);
  });

  it.each([
    [/git add -A/, "blanket staging"],
    [/git\s+commit/, "auto-commit"],
    [/git\s+push/, "auto-push"],
    [/\b(zip|tar\.gz|archiver|adm-zip)\b/i, "repository archive transport"],
    [/uploadFile|sendFile|createReadStream[^)]*send/i, "local file upload path"],
    [/user-data-dir[^'"`]*\$\{?homeDir/i, "attaching the user's browser profile"],
  ])("finds no %s in module sources", (pattern, label) => {
    const offenders = sourceFiles
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(repoRoot, ""));
    expect(offenders, `found ${label} in: ${offenders.join(", ")}`).toEqual([]);
  });
});

function collectTsFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return collectTsFiles(full);
    return entry.endsWith(".ts") ? [full] : [];
  });
}
