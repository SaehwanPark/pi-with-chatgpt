/**
 * Real-git integration coverage.
 *
 * The unit tests drive a fake executor, which proves the decision logic but cannot prove that the
 * invocations we chose are the invocations git actually accepts with the output format we parse —
 * and the read-only allowlist is only meaningful if the commands on it really are read-only and
 * really work. This file runs the production executor against real repositories in a temp directory.
 *
 * It stays offline: the GitHub remote is added as a URL only, never contacted.
 */
import { chmod, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isFullCommitSha, requireFullCommitSha } from "../protocol/sha.js";
import { createGitExecutor, createNodeCommandRunner } from "../git/exec.js";
import { inspectRepository, selectPrimaryGitHubRemote } from "../git/repository.js";
import { resolveCheckpointRef } from "../git/ref-resolution.js";
import { aheadBehind, compareCommits } from "../git/ancestry.js";

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "PWC Test",
  GIT_AUTHOR_EMAIL: "pwc-test@example.invalid",
  GIT_COMMITTER_NAME: "PWC Test",
  GIT_COMMITTER_EMAIL: "pwc-test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

const git = createGitExecutor(createNodeCommandRunner());

async function gitRaw(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd, env: GIT_ENV });
  return stdout.trim();
}

let workspace: string;
let repoDir: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pwc-git-"));
  repoDir = join(workspace, "repo");
  await mkdir(repoDir, { recursive: true });

  await gitRaw(repoDir, ["init", "--initial-branch=main", "--quiet"]);
  // A repository with no commits cannot anchor anything; give it history to inspect.
  await writeFile(join(repoDir, "README.md"), "seed\n");
  await gitRaw(repoDir, ["add", "README.md"]);
  await gitRaw(repoDir, ["commit", "--quiet", "-m", "seed"]);
  await gitRaw(repoDir, ["remote", "add", "origin", "https://github.com/example-org/example-repo.git"]);
  await gitRaw(repoDir, ["tag", "v0.1.0"]);
}, 60_000);

afterAll(async () => {
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

describe("real git inspection", () => {
  it("inspects a real repository through allowlisted invocations only", async () => {
    const inspection = await inspectRepository(git, repoDir);

    expect(inspection.repoRoot).toBe(await gitRaw(repoDir, ["rev-parse", "--show-toplevel"]));
    expect(isFullCommitSha(inspection.headCommit)).toBe(true);
    expect(inspection.head).toMatchObject({ kind: "branch", name: "main" });
    expect(inspection.isShallow).toBe(false);
    expect(inspection.hasUncommittedChanges).toBe(false);
    expect(inspection.worktrees.map((worktree) => worktree.path)).toContain(inspection.repoRoot);

    const selection = selectPrimaryGitHubRemote(inspection.remotes);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.key).toBe("example-org/example-repo");
  });

  it("sees uncommitted changes and untracked files", async () => {
    await writeFile(join(repoDir, "untracked.txt"), "draft\n");
    const inspection = await inspectRepository(git, repoDir);
    expect(inspection.hasUncommittedChanges).toBe(true);
    expect(inspection.dirtyPathsSample).toContain("untracked.txt");
    await rm(join(repoDir, "untracked.txt"));
  });

  it("inspects a real linked worktree", async () => {
    const worktreeDir = join(workspace, "linked");
    await gitRaw(repoDir, ["worktree", "add", "--detach", "--quiet", worktreeDir]);

    const inspection = await inspectRepository(git, worktreeDir);
    expect(inspection.worktrees.length).toBeGreaterThanOrEqual(2);
    expect(inspection.head.kind).toBe("detached");

    await gitRaw(repoDir, ["worktree", "remove", "--force", worktreeDir]);
  });

  it("detects a real shallow clone", async () => {
    const shallowDir = join(workspace, "shallow");
    // `file://` is required: git silently ignores `--depth` for a plain local-path clone (it uses
    // the local-object optimisation instead), and a test that cloned by path would quietly assert
    // nothing about shallow behaviour.
    await gitRaw(workspace, [
      "clone",
      "--depth",
      "1",
      "--quiet",
      `file://${repoDir}`,
      shallowDir,
    ]);

    const inspection = await inspectRepository(git, shallowDir);
    expect(inspection.isShallow).toBe(true);
  });

  it("refuses a directory that is not a repository", async () => {
    const emptyDir = join(workspace, "not-a-repo");
    await mkdir(emptyDir, { recursive: true });
    await expect(inspectRepository(git, emptyDir)).rejects.toMatchObject({
      reason: "not-a-git-repository",
    });
  });

  it("does not execute repo-local fsmonitor or external diff commands", async () => {
    const marker = join(workspace, "repo-local-command-ran");
    const executable = join(workspace, "repo-local-command.sh");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(executable, 0o700);

    try {
      await gitRaw(repoDir, ["config", "core.fsmonitor", executable]);
      await inspectRepository(git, repoDir);

      await gitRaw(repoDir, ["config", "diff.external", executable]);
      await writeFile(join(repoDir, "README.md"), "changed\n");
      await git.run(["diff", "--name-only"], repoDir);

      await expect(readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      await gitRaw(repoDir, ["config", "--unset", "core.fsmonitor"]).catch(() => undefined);
      await gitRaw(repoDir, ["config", "--unset", "diff.external"]).catch(() => undefined);
      await writeFile(join(repoDir, "README.md"), "seed\n");
      await rm(marker, { force: true });
    }
  });
});

describe("real git ref resolution", () => {
  it("resolves HEAD, a branch, a tag, and an abbreviated SHA to the same full SHA", async () => {
    const head = await resolveCheckpointRef(git, repoDir, "HEAD");
    expect(head.ok).toBe(true);
    if (!head.ok) return;
    const sha = head.resolution.resolvedCommit;

    for (const ref of ["main", "v0.1.0", sha, sha.slice(0, 8)]) {
      const resolved = await resolveCheckpointRef(git, repoDir, ref);
      expect(resolved.ok, `ref ${ref} should resolve`).toBe(true);
      if (!resolved.ok) continue;
      // An abbreviated ref must never be persisted as the anchor (INV-03).
      expect(resolved.resolution.resolvedCommit).toBe(sha);
    }
  });

  it("refuses a ref that does not exist", async () => {
    const result = await resolveCheckpointRef(git, repoDir, "no-such-ref");
    expect(result).toMatchObject({ ok: false, rejection: { reason: "unresolvable-ref" } });
  });
});

describe("real force-push behaviour (INV-03)", () => {
  it("keeps the retained local SHA authoritative after the remote is force-pushed", async () => {
    // A real published remote, over `file://` so the test stays offline: this is the scenario the
    // anchor exists for — the remote history is rewritten underneath a consultation.
    const upstream = join(workspace, "upstream.git");
    const clone = join(workspace, "clone");
    await gitRaw(workspace, ["init", "--bare", "--initial-branch=main", "--quiet", upstream]);
    await gitRaw(workspace, ["clone", "--quiet", `file://${upstream}`, clone]);
    await gitRaw(clone, ["config", "user.name", "PWC Test"]);
    await gitRaw(clone, ["config", "user.email", "pwc-test@example.invalid"]);

    await writeFile(join(clone, "base.txt"), "base\n");
    await gitRaw(clone, ["add", "base.txt"]);
    await gitRaw(clone, ["commit", "--quiet", "-m", "base"]);
    const baseSha = requireFullCommitSha(await gitRaw(clone, ["rev-parse", "HEAD"]));

    await writeFile(join(clone, "published.txt"), "published\n");
    await gitRaw(clone, ["add", "published.txt"]);
    await gitRaw(clone, ["commit", "--quiet", "-m", "published"]);
    const publishedSha = requireFullCommitSha(await gitRaw(clone, ["rev-parse", "HEAD"]));
    await gitRaw(clone, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    // The remote is rewritten from the base commit: the published commit is no longer reachable
    // from the new remote tip, yet it must remain a valid anchor.
    await gitRaw(clone, ["reset", "--hard", "--quiet", baseSha]);
    await writeFile(join(clone, "rewritten.txt"), "rewritten\n");
    await gitRaw(clone, ["add", "rewritten.txt"]);
    await gitRaw(clone, ["commit", "--quiet", "-m", "rewritten"]);
    await gitRaw(clone, ["push", "--quiet", "--force", "origin", "HEAD:refs/heads/main"]);
    const rewrittenSha = requireFullCommitSha(await gitRaw(clone, ["rev-parse", "HEAD"]));

    // The old anchor still resolves locally and is unchanged: an active consultation is never
    // retargeted to the rewritten history.
    const retained = await resolveCheckpointRef(git, clone, publishedSha);
    expect(retained.ok).toBe(true);
    if (!retained.ok) return;
    expect(retained.resolution.resolvedCommit).toBe(publishedSha);

    // And the rewritten history is reported as diverged rather than silently treated as equivalent.
    await expect(compareCommits(git, clone, publishedSha, rewrittenSha)).resolves.toBe("diverged");
  }, 60_000);
});

describe("real git ancestry", () => {
  it("reports ahead/behind and divergence for real history", async () => {
    const base = await resolveCheckpointRef(git, repoDir, "HEAD");
    if (!base.ok) throw new Error("baseline resolution failed");
    const baseSha = base.resolution.resolvedCommit;

    // Advance the branch twice so the two sides are genuinely ahead/behind.
    await writeFile(join(repoDir, "second.md"), "2\n");
    await gitRaw(repoDir, ["add", "second.md"]);
    await gitRaw(repoDir, ["commit", "--quiet", "-m", "second"]);
    const advanced = requireFullCommitSha(await gitRaw(repoDir, ["rev-parse", "HEAD"]));

    await expect(compareCommits(git, repoDir, baseSha, advanced)).resolves.toBe(
      "left-ancestor-of-right",
    );
    await expect(compareCommits(git, repoDir, advanced, baseSha)).resolves.toBe(
      "right-ancestor-of-left",
    );
    await expect(aheadBehind(git, repoDir, baseSha, advanced)).resolves.toEqual({
      ahead: 1,
      behind: 0,
    });

    // A branch from the base commit that does not include `advanced` is unrelated-by-lineage, i.e.
    // it has its own commit: diverged once both sides have something the other lacks.
    await gitRaw(repoDir, ["checkout", "--quiet", "-b", "side", baseSha]);
    await writeFile(join(repoDir, "side.md"), "side\n");
    await gitRaw(repoDir, ["add", "side.md"]);
    await gitRaw(repoDir, ["commit", "--quiet", "-m", "side"]);
    const sideSha = requireFullCommitSha(await gitRaw(repoDir, ["rev-parse", "HEAD"]));

    await expect(compareCommits(git, repoDir, sideSha, advanced)).resolves.toBe("diverged");
    await expect(
      compareCommits(git, repoDir, baseSha, requireFullCommitSha("0000000000000000000000000000000000000000")),
    ).resolves.toBeUndefined();

    await gitRaw(repoDir, ["checkout", "--quiet", "main"]);
    await gitRaw(repoDir, ["branch", "-D", "side"]);
    await rm(join(repoDir, "side.md"), { force: true });
  }, 60_000);
});
