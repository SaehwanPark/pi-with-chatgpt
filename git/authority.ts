/**
 * Git authority on the adviser path (INV-06).
 *
 * Asking the adviser for advice grants nothing in git terms. The consultation path may only
 * *inspect* the repository, and that permission is an allowlist of exact invocation prefixes rather
 * than a rule to remember: mutating spellings fail closed, including the ones that hide behind a
 * nominally read-only subcommand (`git remote set-url`, `git branch -D`, `git config --add`).
 *
 * Committing and pushing require a `GitAuthorityToken`, which this module never mints — only an
 * explicit user confirmation does (M8) — and a remote named `origin` is never treated as one.
 */

export type GitAuthorityToken = {
  readonly __brand: "GitAuthorityToken";
  readonly confirmedBy: "user";
  readonly scope: "commit" | "push";
};

export class GitAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitAuthorityError";
  }
}

/**
 * Prefixes the consultation path may run. Anything not matching one of these exactly is refused, so
 * adding capability here is a reviewable, greppable change.
 */
export const READ_ONLY_GIT_INVOCATIONS = [
  "rev-parse",
  "rev-list",
  "cat-file",
  "ls-tree",
  "ls-remote",
  "merge-base",
  "diff",
  "log",
  "show",
  "status",
  "describe",
  "count-objects",
  "symbolic-ref",
  "for-each-ref",
  "is-ancestor",
  "branch --show-current",
  "branch --list",
  "branch -a",
  "branch -r",
  "worktree list",
  "remote -v",
  "remote show",
  "remote get-url",
  "config --get",
  "config --get-all",
  "config --list",
] as const;

export type ReadOnlyGitInvocation = (typeof READ_ONLY_GIT_INVOCATIONS)[number];

/**
 * Arguments that must never appear on the consultation path, even inside an allowed prefix. Long
 * `--flags` are matched as substrings (so `--force-with-lease` and `--config=--delete` are caught);
 * short tokens are matched exactly, because otherwise ordinary path arguments would false-positive.
 * The guard fails closed: a refused inspection is annoying, an unintended write is not.
 */
export const FORBIDDEN_GIT_ARG_TOKENS: readonly string[] = [
  "add",
  "-A",
  "--all",
  "commit",
  "push",
  "-f",
  "--force",
  "--force-with-lease",
  "reset",
  "restore",
  "checkout",
  "switch",
  "clean",
  "merge",
  "rebase",
  "am",
  "apply",
  "rm",
  "mv",
  "fetch",
  "pull",
  "tag",
  "stash",
  "gc",
  "prune",
  "set-url",
  "set-head",
  "unset",
  "--delete",
  "-D",
  "-d",
  "--add",
  // Read-only subcommands still accept arguments that write files or execute programs. They are
  // forbidden because "the subcommand is safe" is not the rule; the resolved invocation is.
  "--output", // log/diff/show --output=<path> writes a file
  "--ext-diff", // runs core.git_hooks_path/ext-diff external converters
  "--textconv",
  "-p", // short spelling of --paginate: runs core.pager, i.e. an arbitrary program
  "--exec", // --upload-pack's alias in the fetch/ls-remote family
  "--push", // ls-remote --push asks about push targets; no consultation path needs it
  "--paginate",
  "--upload-pack", // ls-remote --upload-pack=<prog> executes a program
  "--receive-pack",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "-c", // git -c core.pager=<prog> … reconfigures the read-only invocation
  "-C",
  "--namespace",
  "--super-prefix",
] as const;

/**
 * Prefix-only convenience check: does this invocation start with an allowlisted read-only command?
 * It is *not* the safety gate — `assertReadOnlyGitArgs` additionally rejects arguments that write
 * files or execute programs, and only that function may decide whether a command runs.
 */
export function isReadOnlyGitInvocation(argv: readonly string[]): boolean {
  return invocationPrefix(argv) !== undefined;
}

/** Validate a would-be `git` argument vector for the consultation path; throws when not read-only. */
export function assertReadOnlyGitArgs(argv: readonly string[]): readonly string[] {
  const prefix = invocationPrefix(argv);
  if (prefix === undefined) {
    const head = argv[0] ?? "";
    throw new GitAuthorityError(
      `"git ${head}" is not on the read-only consultation allowlist; adviser work never authorises repository mutation.`,
    );
  }
  const offending = FORBIDDEN_GIT_ARG_TOKENS.find((token) =>
    argv.some((argument) => argument === token || (token.startsWith("--") && argument.includes(token))),
  );
  if (offending !== undefined) {
    throw new GitAuthorityError(`"git ${prefix} …" uses the forbidden argument "${offending}".`);
  }
  return argv;
}

function invocationPrefix(argv: readonly string[]): ReadOnlyGitInvocation | undefined {
  if (argv.length === 0) return undefined;
  const one = argv.slice(0, 1).join(" ");
  const two = argv.slice(0, 2).join(" ");
  return (READ_ONLY_GIT_INVOCATIONS as readonly string[]).find(
    (invocation) => invocation === two || (invocation.includes(" ") === false && invocation === one),
  ) as ReadOnlyGitInvocation | undefined;
}

/**
 * Human-readable refusal for the "checkpoint is not on GitHub" path. The worker handles it under its
 * normal git permissions; the extension never stages, commits, or pushes on the adviser's behalf.
 */
export const CHECKPOINT_NOT_REMOTE_GUIDANCE =
  "The checkpoint is not available on the selected GitHub remote. Push it yourself, or pick a commit that is already pushed. " +
  "pi-with-chatgpt will not stage, commit, or push for you.";
