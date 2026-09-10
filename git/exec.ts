/**
 * The only way anything in this project reaches `git`.
 *
 * Two jobs, in this order:
 *
 * 1. **Enforce read-only authority.** Every invocation passes the `git/authority.ts` gate *before*
 *    the process is spawned, and the binary is a fixed `"git"` constant so a caller cannot smuggle
 *    a different program through configuration. A refusal is a `GitExecutionError` with reason
 *    `"refused"` — it is never downgraded to a warning.
 * 2. **Run non-interactively and non-invasively.** `GIT_TERMINAL_PROMPT=0` means a credential
 *    challenge fails fast instead of hanging the worker, `GIT_PAGER=cat` means a command that
 *    somehow wants a pager cannot block on a TTY, and `GIT_OPTIONAL_LOCKS=0` stops nominally
 *    read-only commands (`status`, `for-each-ref`) from taking an index lock that a concurrent
 *    human operation would then have to wait for.
 *
 * Output is returned raw; process *stderr* is redacted of credential-shaped material before it
 * becomes part of an error, because `git ls-remote https://<token>@…` echoes the URL it was given
 * and error text ends up in UI, logs, and — if we are careless — adviser context (INV-12).
 */

import { GitAuthorityError, assertReadOnlyGitArgs } from "./authority.js";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn abstraction so tests never need a real repository or a real `git` binary. */
export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number }
  ): Promise<CommandResult>;
}

export type GitExecutionFailure =
  /** The allowlist refused the invocation; nothing was spawned. */
  | "refused"
  | "git-not-found"
  | "timed-out"
  /** `git` ran and exited non-zero. Use `runAllowingFailure` when non-zero is a real answer. */
  | "exited-non-zero";

export class GitExecutionError extends Error {
  readonly reason: GitExecutionFailure;
  /** Redacted, truncated, and safe to show a human. Never contains a credential. */
  readonly detail: string;

  constructor(reason: GitExecutionFailure, detail: string, invocation: readonly string[]) {
    // The invocation itself is redacted too: `git ls-remote https://<token>@host/…` carries the
    // credential in an argument, and this message is what reaches logs and the worker.
    super(redactGitOutput(`git ${invocation.join(" ")}`) + ` failed (${reason}): ${detail}`);
    this.name = "GitExecutionError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Strip anything credential-shaped from process output. Deliberately narrow: URL userinfo (the
 * shape `git` echoes back), `Authorization` headers, and explicit token parameters. Generic
 * "looks random" scrubbing would destroy legitimate SHAs and ref names in this output.
 */
export function redactGitOutput(text: string): string {
  return text
    // URL userinfo, with or without a colon. git echoes the whole remote URL back
    // (`fatal: Authentication failed for 'https://user:pw@github.com/…'`), and a token used as the
    // username (`https://ghp_xxx@github.com/o/r`, which git accepts) has no colon to anchor on, so
    // the userinfo class must be matched as a whole.
    .replace(/\/\/[^/@\s]*@/g, "//[redacted]@")
    .replace(/(proxy-authorization|authorization)\s*[:=][^\r\n]*/gi, "$1: [redacted]")
    .replace(/(access_token|auth|code|password|token)=([^&\s]+)/gi, "$1=[redacted]")
    // GitHub token shapes, wherever they appear (remote URL userinfo, proxy URL, pasted hint text).
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,})\b/g, "[redacted-token]")
    // Generic bearer material in a header-looking context.
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]{8,}/giu, "bearer [redacted]");
}

/** Truncate before display: git can emit kilobytes of hint text, and errors get surfaced inline. */
function summarize(stderr: string, stdout: string): string {
  const combined = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0).join("\n");
  const redacted = redactGitOutput(combined);
  return redacted.length <= 400 ? redacted : `${redacted.slice(0, 400)}…`;
}

/**
 * `GIT_CONFIG_NOSYSTEM=1` is not hygiene theatre: a system-level `url.<base>.insteadOf` rewrite would
 * silently point a canonical GitHub remote at another host, which is exactly the retargeting INV-04
 * forbids. Losing a site-wide alias is the cheaper failure.
 */
/**
 * Threat-model boundary for repo-local git configuration.
 *
 * `GIT_CONFIG_NOSYSTEM=1` removes *system* config and `-c` is forbidden, so the extension can never
 * reconfigure an invocation — but a repository's own `.git/config` still applies, and git's own trust
 * boundary is what covers that: running git against a repository the user does not trust is outside
 * this extension's threat model. Concretely `core.fsmonitor` (honoured by `git status`) and
 * `diff.external` (honoured by `diff`/`log -p`/`show`) execute programs named in that config; the
 * argument-level guards in `authority.ts` block the flags that would opt into them per-invocation.
 * A change that runs git against an arbitrary, unvetted path must revisit this assumption rather than
 * inherit it silently.
 */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  GIT_PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
};

const DEFAULT_TIMEOUT_MS = 15_000;

export interface GitExecutor {
  /** Run an allowed invocation and return trimmed stdout; throws on refusal or non-zero exit. */
  run(invocation: readonly string[], cwd: string): Promise<string>;
  /** Run an allowed invocation, returning the exit status instead of throwing on non-zero. */
  runAllowingFailure(invocation: readonly string[], cwd: string): Promise<CommandResult>;
}

export function createGitExecutor(
  runner: CommandRunner,
  options: { readonly timeoutMs?: number } = {},
): GitExecutor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function spawn(invocation: readonly string[], cwd: string): Promise<CommandResult> {
    // Refusal happens before any process exists: the guard is not a filter applied afterwards. The
    // authority error is re-wrapped so callers handle one error type and cannot catch-and-continue.
    try {
      assertReadOnlyGitArgs(invocation);
    } catch (error) {
      if (error instanceof GitAuthorityError) {
        throw new GitExecutionError("refused", error.message, invocation);
      }
      throw error;
    }
    try {
      return await runner.run("git", [...invocation], { cwd, env: GIT_ENV, timeoutMs });
    } catch (error) {
      if (error instanceof GitExecutionError) throw error;
      throw new GitExecutionError("git-not-found", redactGitOutput(String(error)), invocation);
    }
  }

  async function run(invocation: readonly string[], cwd: string): Promise<string> {
    const result = await spawn(invocation, cwd);
    // 124 is the runner's own "killed or buffer-exceeded" sentinel (see createNodeCommandRunner).
    if (result.code === 124) {
      throw new GitExecutionError("timed-out", summarize(result.stderr, result.stdout), invocation);
    }
    if (result.code !== 0) {
      throw new GitExecutionError("exited-non-zero", summarize(result.stderr, result.stdout), invocation);
    }
    return result.stdout.trim();
  }

  async function runAllowingFailure(invocation: readonly string[], cwd: string): Promise<CommandResult> {
    const result = await spawn(invocation, cwd);
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: redactGitOutput(result.stderr),
    };
  }

  return { run, runAllowingFailure };
}

/**
 * Node's `child_process` behind the runner interface. Kept in one place so the "we spawn exactly one
 * program, read-only" claim stays greppable.
 */
export function createNodeCommandRunner(): CommandRunner {
  return {
    async run(command, args, { cwd, env, timeoutMs }) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execute = promisify(execFile);
      try {
        const { stdout, stderr } = await execute(command, [...args], {
          cwd,
          env: { ...process.env, ...env },
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          // A timeout or a signal is reported through the error object; treat both as exit 124.
          killSignal: "SIGKILL",
        });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failure = error as { code?: number | string; stderr?: string; stdout?: string; killed?: boolean };
        const code =
          failure.killed === true || failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? 124
            : typeof failure.code === "number"
              ? failure.code
              : 127;
        return {
          code,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? (typeof failure.code === "string" ? String(failure.code) : ""),
        };
      }
    },
  };
}
