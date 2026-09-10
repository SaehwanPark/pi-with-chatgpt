import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_SHA,
  OTHER_CHECKPOINT_SHA,
  fakeGit,
  type FakeGitOutcome,
} from "../test/fixtures.js";
import {
  inspectRepository,
  parseRemoteVerbose,
  parseStatusPorcelain,
  parseWorktreeList,
  selectPrimaryGitHubRemote,
  RepositoryInspectionError,
} from "./repository.js";

const REMOTES_TWO_GITHUB =
  "origin\thttps://github.com/SaehwanPark/pi-with-chatgpt.git (fetch)\n" +
  "origin\thttps://github.com/SaehwanPark/pi-with-chatgpt.git (push)\n" +
  "upstream\tgit@github.com:upstream/pi-with-chatgpt.git (fetch)\n" +
  "upstream\tgit@github.com:upstream/pi-with-chatgpt.git (push)\n";

function baseHandlers(overrides: Record<string, FakeGitOutcome | string> = {}) {
  return {
    "rev-parse --show-toplevel": "/repo",
    "rev-parse --verify --quiet HEAD^{commit}": CHECKPOINT_SHA,
    "symbolic-ref --quiet --short HEAD": "main",
    "rev-parse --is-shallow-repository": "false",
    "worktree list --porcelain": `worktree /repo\nHEAD ${CHECKPOINT_SHA}\nbranch refs/heads/main\n\n`,
    "status --porcelain --untracked-files=all": "",
    "remote -v": REMOTES_TWO_GITHUB,
    ...overrides,
  };
}

describe("parseRemoteVerbose", () => {
  it("parses HTTPS and scp-like remotes and canonicalises both through parseGitHubRemote", () => {
    const remotes = parseRemoteVerbose(REMOTES_TWO_GITHUB);
    const origin = remotes.get("origin");
    const upstream = remotes.get("upstream");

    expect(origin?.github.ok).toBe(true);
    expect(origin?.github.key).toBe("saehwanpark/pi-with-chatgpt");
    // Same key regardless of SSH vs HTTPS spelling: the key is the Project identity (INV-08).
    expect(upstream?.github.key).toBe("upstream/pi-with-chatgpt");
    expect(origin?.fetchUrl).toBe("https://github.com/SaehwanPark/pi-with-chatgpt.git");
    expect(origin?.pushUrl).toBe(origin?.fetchUrl);
  });

  it("refuses a remote whose URL embeds credentials instead of quietly cleaning it", () => {
    const remotes = parseRemoteVerbose(
      "origin\thttps://ghp_secrettoken@github.com/o/r.git (fetch)\n",
    );
    expect(remotes.get("origin")?.github.rejection).toBe("credentials-in-url");
  });

  it("marks a non-GitHub host as unsupported", () => {
    const remotes = parseRemoteVerbose("origin\tgit@gitlab.com:o/r.git (fetch)\n");
    expect(remotes.get("origin")?.github.rejection).toBe("unsupported-host");
  });
});

describe("parseWorktreeList", () => {
  it("parses the main worktree plus a linked worktree", () => {
    const worktrees = parseWorktreeList(
      `worktree /repo\nHEAD ${CHECKPOINT_SHA}\nbranch refs/heads/main\n\n` +
        `worktree /repo-linked\nHEAD ${OTHER_CHECKPOINT_SHA}\nbranch refs/heads/feature\n\n`,
    );

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toEqual({
      path: "/repo",
      head: CHECKPOINT_SHA,
      branch: "refs/heads/main",
      bare: false,
    });
    expect(worktrees[1]?.path).toBe("/repo-linked");
    expect(worktrees[1]?.head).toBe(OTHER_CHECKPOINT_SHA);
  });

  it("parses a bare worktree without a HEAD line", () => {
    const worktrees = parseWorktreeList("worktree /bare\nbare\n\n");
    expect(worktrees[0]).toEqual({ path: "/bare", head: undefined, branch: undefined, bare: true });
  });
});

describe("parseStatusPorcelain", () => {
  it("reports modified and untracked paths", () => {
    expect(parseStatusPorcelain(" M git/exec.ts\n?? git/new.ts\n")).toEqual([
      "git/exec.ts",
      "git/new.ts",
    ]);
  });

  it("keeps the original path of a rename", () => {
    expect(parseStatusPorcelain("R  old/name.ts -> new/name.ts\n")).toEqual(["old/name.ts"]);
  });

  it("treats a clean tree as no paths", () => {
    expect(parseStatusPorcelain("")).toEqual([]);
  });

  it("survives a trimmed first line, whose leading status space is gone", () => {
    // `GitExecutor.run` trims stdout, so the first line arrives as `M file` rather than ` M file`.
    // A fixed 3-character offset used to eat one character of that path.
    expect(parseStatusPorcelain("M git/exec.ts\n?? git/new.ts\n")).toEqual([
      "git/exec.ts",
      "git/new.ts",
    ]);
    expect(parseStatusPorcelain(" M git/exec.ts\n?? git/new.ts\n")).toEqual([
      "git/exec.ts",
      "git/new.ts",
    ]);
  });

  it("unquotes a path git escaped", () => {
    expect(parseStatusPorcelain('?? "my file.txt"\n')).toEqual(["my file.txt"]);
  });
});

describe("selectPrimaryGitHubRemote", () => {
  const remotes = [...parseRemoteVerbose(REMOTES_TWO_GITHUB).values()];

  it("prefers origin and reports why", () => {
    const selection = selectPrimaryGitHubRemote(remotes);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.remote.name).toBe("origin");
    expect(selection.selectedBecause).toBe("preferred-origin");
    expect(selection.key).toBe("saehwanpark/pi-with-chatgpt");
  });

  it("falls back to upstream when origin is not a GitHub remote", () => {
    const selection = selectPrimaryGitHubRemote([
      { ...remotes[0]!, name: "origin", url: "https://gitlab.com/o/r.git", github: { ok: false, rejection: "unsupported-host" } },
      remotes[1]!,
    ]);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.remote.name).toBe("upstream");
    expect(selection.selectedBecause).toBe("preferred-upstream");
    // The skipped remote is reported, not dropped: "why did it ask about the fork?" needs an answer.
    expect(selection.rejected).toEqual([
      { name: "origin", url: "https://gitlab.com/o/r.git", reason: "unsupported-host" },
    ]);
  });

  it("is deterministic across remote listing order when neither origin nor upstream exists", () => {
    const alpha = { name: "zeta", url: "git@github.com:o/zeta.git", fetchUrl: undefined, pushUrl: undefined, github: { ok: true as const, key: "o/zeta" as never } };
    const beta = { name: "beta", url: "git@github.com:o/beta.git", fetchUrl: undefined, pushUrl: undefined, github: { ok: true as const, key: "o/beta" as never } };

    const first = selectPrimaryGitHubRemote([alpha, beta]);
    const second = selectPrimaryGitHubRemote([beta, alpha]);
    expect(first.kind).toBe("selected");
    if (first.kind !== "selected" || second.kind !== "selected") return;
    expect(first.remote.name).toBe("beta");
    expect(second.remote.name).toBe(first.remote.name);
    expect(first.selectedBecause).toBe("first-github-remote-by-name");
  });

  it("refuses when no remote is a supported GitHub remote", () => {
    const selection = selectPrimaryGitHubRemote([
      { name: "origin", url: "https://gitlab.com/o/r.git", fetchUrl: undefined, pushUrl: undefined, github: { ok: false, rejection: "unsupported-host" } },
    ]);
    expect(selection.kind).toBe("no-github-remote");
    if (selection.kind !== "no-github-remote") return;
    expect(selection.considered).toEqual(["origin"]);
    expect(selection.rejected[0]?.reason).toBe("unsupported-host");
  });
});

describe("inspectRepository", () => {
  it("describes a clean branch repository with its GitHub remotes", async () => {
    const { executor, invocations } = fakeGit(baseHandlers());

    const inspection = await inspectRepository(executor, "/repo/subdir");

    expect(inspection.repoRoot).toBe("/repo");
    expect(inspection.head).toEqual({ kind: "branch", name: "main", commit: CHECKPOINT_SHA });
    expect(inspection.headCommit).toBe(CHECKPOINT_SHA);
    expect(inspection.hasUncommittedChanges).toBe(false);
    expect(inspection.isShallow).toBe(false);
    expect(inspection.remotes.map((remote) => remote.name)).toEqual(["origin", "upstream"]);
    // Every command issued is one the read-only allowlist permits; the list is pinned so a new
    // command has to be reviewed rather than quietly added.
    expect(invocations).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      ["rev-parse", "--is-shallow-repository"],
      ["worktree", "list", "--porcelain"],
      ["status", "--porcelain", "--untracked-files=all"],
      ["remote", "-v"],
    ]);
  });

  it("reports detached HEAD with the commit it is detached at", async () => {
    const { executor } = fakeGit(
      baseHandlers({ "symbolic-ref --quiet --short HEAD": { code: 1, stdout: "" } }),
    );

    const inspection = await inspectRepository(executor, "/repo");
    expect(inspection.head).toEqual({ kind: "detached", commit: CHECKPOINT_SHA });
  });

  it("detects uncommitted changes and caps the reported sample", async () => {
    const many = Array.from({ length: 25 }, (_unused, index) => ` M file-${index}.ts`).join("\n");
    const { executor } = fakeGit(baseHandlers({ "status --porcelain --untracked-files=all": many }));

    const inspection = await inspectRepository(executor, "/repo");
    expect(inspection.hasUncommittedChanges).toBe(true);
    expect(inspection.dirtyPathsSample).toHaveLength(10);
  });

  it("detects a shallow repository", async () => {
    const { executor } = fakeGit(baseHandlers({ "rev-parse --is-shallow-repository": "true" }));
    const inspection = await inspectRepository(executor, "/repo");
    expect(inspection.isShallow).toBe(true);
  });

  it("refuses with a structured reason outside a repository", async () => {
    const { executor } = fakeGit({
      "rev-parse --show-toplevel": { code: 128, stderr: "fatal: not a git repository" },
    });

    await expect(inspectRepository(executor, "/tmp")).rejects.toMatchObject({
      reason: "not-a-git-repository",
    });
    await expect(inspectRepository(executor, "/tmp")).rejects.toBeInstanceOf(
      RepositoryInspectionError,
    );
  });

  it("distinguishes an empty repository from a missing one", async () => {
    const { executor } = fakeGit(
      baseHandlers({
        "rev-parse --verify --quiet HEAD^{commit}": { code: 1, stdout: "" },
      }),
    );

    await expect(inspectRepository(executor, "/repo")).rejects.toMatchObject({
      reason: "repository-has-no-commits",
    });
  });
});
