import { isFullCommitSha, type FullCommitSha } from "../protocol/sha.js";
import {
  parseGitHubRemote,
  type GitHubRemoteParseResult,
  type GitHubRepositoryKey,
} from "../protocol/repo.js";
import { redactGitOutput, type GitExecutor } from "./exec.js";

/**
 * Read-only repository inspection: what repository are we in, where is HEAD, what remotes exist,
 * and is the working tree dirty.
 *
 * Every value here feeds INV-03 (the anchor must name a real commit) or INV-04 (the remote probe
 * needs the remote it is probing), so the rule is: report what git actually said, and where git
 * cannot answer, say so structurally rather than guessing.
 */

export type RepositoryInspectionErrorReason =
  | "not-a-git-repository"
  | "repository-has-no-commits"
  | "git-probe-failed";

export class RepositoryInspectionError extends Error {
  readonly reason: RepositoryInspectionErrorReason;
  readonly cwd: string;

  constructor(reason: RepositoryInspectionErrorReason, cwd: string, detail?: string) {
    // Detail is git output: redacted, and never the only signal (INV-12).
    super(
      `Repository inspection failed (${reason}) in ${cwd}${detail ? `: ${redactGitOutput(detail)}` : ""}`,
    );
    this.name = "RepositoryInspectionError";
    this.reason = reason;
    this.cwd = cwd;
  }
}

export type GitRemoteInfo = {
  readonly name: string;
  readonly url: string;
  readonly fetchUrl: string | undefined;
  readonly pushUrl: string | undefined;
  readonly github: GitHubRemoteParseResult;
};

export type HeadState =
  | { readonly kind: "branch"; readonly name: string; readonly commit: FullCommitSha }
  | { readonly kind: "detached"; readonly commit: FullCommitSha };

export type WorktreeInfo = {
  readonly path: string;
  readonly head: FullCommitSha | undefined;
  readonly branch: string | undefined;
  readonly bare: boolean;
};

export type RepositoryInspection = {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly head: HeadState;
  readonly headCommit: FullCommitSha;
  readonly isShallow: boolean;
  readonly worktrees: readonly WorktreeInfo[];
  readonly hasUncommittedChanges: boolean;
  /** Capped sample so the UI can explain an uncommitted checkpoint without dumping the tree. */
  readonly dirtyPathsSample: readonly string[];
  readonly remotes: readonly GitRemoteInfo[];
};

/** Maximum number of dirty paths kept; the count is reported, the list is a sample. */
export const DIRTY_PATH_SAMPLE_LIMIT = 10;

/** `git remote -v` line: `<name>\t<url> (fetch|push)`. */
export function parseRemoteVerbose(output: string): ReadonlyMap<string, GitRemoteInfo> {
  const partial = new Map<string, { url?: string; fetch?: string; push?: string }>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length !== 2) continue;
    const name = parts[0] as string;
    const rest = parts[1] as string;
    const match = /^(.*?)\s+\((fetch|push)\)$/.exec(rest);
    if (match === null) continue;
    const url = (match[1] as string).trim();
    const kind = match[2] as "fetch" | "push";
    const entry = partial.get(name) ?? {};
    entry.url = entry.url ?? url;
    if (kind === "fetch") entry.fetch = url;
    else entry.push = url;
    partial.set(name, entry);
  }

  const remotes = new Map<string, GitRemoteInfo>();
  for (const [name, value] of partial) {
    const url = value.url ?? "";
    remotes.set(name, {
      name,
      url,
      fetchUrl: value.fetch,
      pushUrl: value.push,
      github: parseGitHubRemote(url),
    });
  }
  return remotes;
}

/** `git worktree list --porcelain` record block. */
export function parseWorktreeList(output: string): readonly WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: { path?: string; head?: string; branch?: string; bare: boolean } | undefined;

  const flush = (): void => {
    if (current !== undefined && current.path !== undefined) {
      worktrees.push({
        path: current.path,
        head: current.head !== undefined && isFullCommitSha(current.head) ? current.head : undefined,
        branch: current.branch,
        bare: current.bare,
      });
    }
    current = undefined;
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { bare: false };
      current.path = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("HEAD ")) {
      const head = line.slice("HEAD ".length).trim();
      current = current ?? { bare: false };
      current.head = isFullCommitSha(head) ? head : undefined;
      continue;
    }
    if (line.startsWith("branch ")) {
      current = current ?? { bare: false };
      current.branch = line.slice("branch ".length).trim();
      continue;
    }
    if (line === "bare") {
      current = current ?? { bare: false };
      current.bare = true;
      continue;
    }
    if (line.trim() === "") flush();
  }
  flush();
  return worktrees;
}

/** `git status --porcelain --untracked-files=all` output; non-empty means the checkpoint is not all of the work. */
export function parseStatusPorcelain(output: string): readonly string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    // Porcelain v1 is `XY<space>path`. The status columns are exactly two characters, but only the
    // *first* line keeps a leading space after output trimming, so a fixed column offset silently
    // eats one character of that path (`it/exec.ts` instead of `git/exec.ts`). Strip the two status
    // characters and one optional space instead: correct for both shapes.
    const withoutStatus = line.slice(2).replace(/^ /, "");
    // A rename is `old -> new`; the path the user recognises is the original one. Quoted paths are
    // git's escaping for names containing spaces or control characters.
    const path = (withoutStatus.split(" -> ")[0] as string).replace(/^"|"$/gu, "").trim();
    if (path !== "") paths.push(path);
  }
  return paths;
}

export type RemoteRejection = {
  readonly name: string;
  readonly url: string;
  readonly reason: string;
};

export type RemoteSelectionReason =
  | "preferred-origin"
  | "preferred-upstream"
  | "first-github-remote-by-name";

export type RemoteSelection =
  | {
      readonly kind: "selected";
      readonly remote: GitRemoteInfo;
      readonly key: GitHubRepositoryKey;
      /** Why this remote was chosen; fork/upstream setups must be explainable to the user. */
      readonly selectedBecause: RemoteSelectionReason;
      readonly considered: readonly string[];
      readonly rejected: readonly RemoteRejection[];
    }
  | {
      readonly kind: "no-github-remote";
      readonly considered: readonly string[];
      readonly rejected: readonly RemoteRejection[];
    };

type GitHubCandidate = {
  readonly remote: GitRemoteInfo;
  readonly key: GitHubRepositoryKey;
};

/**
 * Deterministic remote selection: `origin`, then `upstream`, then the lexicographically first
 * GitHub remote. Determinism matters because the selection decides the consultation's home
 * repository (INV-08), and a fork/upstream layout must not depend on `git remote -v` output order.
 */
export function selectPrimaryGitHubRemote(
  remotes: readonly GitRemoteInfo[],
): RemoteSelection {
  const considered = remotes.map((remote) => remote.name).sort();
  const rejected: RemoteRejection[] = [];
  const candidates: GitHubCandidate[] = [];
  for (const remote of remotes) {
    const key = remote.github.ok ? remote.github.key : undefined;
    if (key !== undefined) candidates.push({ remote, key });
    else rejected.push({ name: remote.name, url: remote.url, reason: remote.github.rejection ?? "not-a-github-remote" });
  }
  if (candidates.length === 0) return { kind: "no-github-remote", considered, rejected };

  const byName = new Map(candidates.map((candidate) => [candidate.remote.name, candidate]));
  const selected =
    byName.get("origin") !== undefined
      ? { candidate: byName.get("origin") as GitHubCandidate, because: "preferred-origin" as const }
      : byName.get("upstream") !== undefined
        ? { candidate: byName.get("upstream") as GitHubCandidate, because: "preferred-upstream" as const }
        : {
            candidate: byName.get(candidates.map((c) => c.remote.name).sort()[0] as string) as GitHubCandidate,
            because: "first-github-remote-by-name" as const,
          };

  return {
    kind: "selected",
    remote: selected.candidate.remote,
    key: selected.candidate.key,
    selectedBecause: selected.because,
    considered,
    rejected,
  };
}

/** Trim a git failure's output for an error message; the reason field stays the authoritative signal. */
function detailOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : String(error);
}

async function readOptional(
  git: GitExecutor,
  cwd: string,
  invocation: readonly string[],
): Promise<string | undefined> {
  // Exit-1 is a real answer for several inspection commands (`symbolic-ref -q` on detached HEAD),
  // so failures here must not become exceptions.
  const result = await git.runAllowingFailure(invocation, cwd);
  if (result.code !== 0) return undefined;
  const stdout = result.stdout.trim();
  return stdout === "" ? undefined : stdout;
}

async function readRequired(
  git: GitExecutor,
  cwd: string,
  invocation: readonly string[],
  failureReason: RepositoryInspectionErrorReason,
): Promise<string> {
  try {
    return (await git.run(invocation, cwd)).trim();
  } catch (error) {
    throw new RepositoryInspectionError(failureReason, cwd, detailOf(error));
  }
}

export async function inspectRepository(
  git: GitExecutor,
  cwd: string,
): Promise<RepositoryInspection> {
  // Subdirectory invocation must describe the repository, not the directory.
  const repoRoot = await readRequired(
    git,
    cwd,
    ["rev-parse", "--show-toplevel"],
    "not-a-git-repository",
  );

  const headCommitRaw = await readOptional(git, repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD^{commit}",
  ]);
  // An empty repository has no commit to anchor a consultation on; that is a distinct refusal.
  if (headCommitRaw === undefined || !isFullCommitSha(headCommitRaw)) {
    throw new RepositoryInspectionError("repository-has-no-commits", repoRoot);
  }
  const headCommit: FullCommitSha = headCommitRaw;

  const branchName = await readOptional(git, repoRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const head: HeadState =
    branchName === undefined
      ? { kind: "detached", commit: headCommit }
      : { kind: "branch", name: branchName, commit: headCommit };

  const shallowRaw = await readOptional(git, repoRoot, ["rev-parse", "--is-shallow-repository"]);
  const isShallow = shallowRaw === "true";

  const worktreeOutput = await git
    .run(["worktree", "list", "--porcelain"], repoRoot)
    .catch(() => "");
  const worktrees = parseWorktreeList(worktreeOutput);

  const statusOutput = await readRequired(
    git,
    repoRoot,
    ["status", "--porcelain", "--untracked-files=all"],
    "git-probe-failed",
  );
  const dirtyPaths = parseStatusPorcelain(statusOutput);

  const remoteOutput = await readRequired(
    git,
    repoRoot,
    ["remote", "-v"],
    "git-probe-failed",
  );
  const remotes = [...parseRemoteVerbose(remoteOutput).values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  return {
    repoRoot,
    cwd,
    head,
    headCommit,
    isShallow,
    worktrees,
    hasUncommittedChanges: dirtyPaths.length > 0,
    dirtyPathsSample: dirtyPaths.slice(0, DIRTY_PATH_SAMPLE_LIMIT),
    remotes,
  };
}
