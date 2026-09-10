import { describe, expect, it } from "vitest";

import { GitExecutionError, createGitExecutor, redactGitOutput, type CommandResult, type CommandRunner } from "./exec.js";

/** Records what was asked to run so "refused before spawn" is an assertion, not a claim. */
function fakeRunner(result: Partial<CommandResult> & { readonly throws?: Error } = {}) {
  const calls: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const runner: CommandRunner = {
    // Not `async`: the fake answers synchronously, and a failure has to surface as a rejected
    // promise exactly where the real runner rejects.
    run(command, args, options) {
      calls.push({ command, args, env: options.env });
      if (result.throws !== undefined) return Promise.reject(result.throws);
      return Promise.resolve({
        code: result.code ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      });
    },
  };
  return { runner, calls };
}

describe("createGitExecutor", () => {
  it("runs an allowed read-only invocation with the fixed git binary", async () => {
    const { runner, calls } = fakeRunner({ stdout: " abc123\n" });
    const git = createGitExecutor(runner);

    await expect(git.run(["rev-parse", "HEAD"], "/repo")).resolves.toBe("abc123");
    expect(calls[0]?.command).toBe("git");
    expect(calls[0]?.args).toEqual(["rev-parse", "HEAD"]);
  });

  it("refuses a mutating invocation without spawning anything", async () => {
    const { runner, calls } = fakeRunner({ stdout: "should-not-run" });
    const git = createGitExecutor(runner);

    await expect(git.run(["add", "-A"], "/repo")).rejects.toThrow(GitExecutionError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["log --output=/tmp/x", ["log", "--output=/tmp/x"]],
    ["ls-remote --upload-pack=/bin/sh", ["ls-remote", "--upload-pack=/bin/sh"]],
    ["config user.name x", ["config", "user.name", "x"]],
  ])("refuses %s before spawn", async (_label, invocation) => {
    const { runner, calls } = fakeRunner();
    const git = createGitExecutor(runner);

    await expect(git.run(invocation, "/repo")).rejects.toThrow(/refused/);
    expect(calls).toHaveLength(0);
  });

  it("runs non-interactively so a credential challenge cannot hang the worker", async () => {
    const { runner, calls } = fakeRunner({ stdout: "x" });
    const git = createGitExecutor(runner);

    await git.run(["ls-remote", "--heads", "origin"], "/repo");
    expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(calls[0]?.env.GIT_PAGER).toBe("cat");
    expect(calls[0]?.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(calls[0]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("reports a non-zero exit as exited-non-zero with a redacted summary", async () => {
    const { runner } = fakeRunner({
      code: 128,
      stderr: "fatal: could not read a token: https://user:ghp_secretsecret@github.com/o/r.git",
    });
    const git = createGitExecutor(runner);

    const error = await git.run(["ls-remote", "origin"], "/repo").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitExecutionError);
    const failure = error as GitExecutionError;
    expect(failure.reason).toBe("exited-non-zero");
    expect(failure.detail).not.toContain("ghp_secretsecret");
    expect(failure.message).not.toContain("ghp_secretsecret");
  });

  it("maps the timeout sentinel to timed-out", async () => {
    const { runner } = fakeRunner({ code: 124, stderr: "killed" });
    const git = createGitExecutor(runner);

    const error = await git.run(["status", "--porcelain"], "/repo").catch((e: unknown) => e);
    expect((error as GitExecutionError).reason).toBe("timed-out");
  });

  it("maps a missing binary to git-not-found", async () => {
    const { runner } = fakeRunner({ throws: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });
    const git = createGitExecutor(runner);

    const error = await git.run(["rev-parse", "HEAD"], "/repo").catch((e: unknown) => e);
    expect((error as GitExecutionError).reason).toBe("git-not-found");
  });

  it("returns the exit status instead of throwing when the caller expects failure", async () => {
    const { runner } = fakeRunner({ code: 1, stderr: "" });
    const git = createGitExecutor(runner);

    const result = await git.runAllowingFailure(["symbolic-ref", "-q", "--short", "HEAD"], "/repo");
    expect(result.code).toBe(1);
  });

  it("redacts stderr from the failure-tolerant path too", async () => {
    const { runner } = fakeRunner({ code: 128, stderr: "remote: Authorization: Bearer ghp_deadbeef" });
    const git = createGitExecutor(runner);

    const result = await git.runAllowingFailure(["ls-remote", "origin"], "/repo");
    expect(result.stderr).not.toContain("ghp_deadbeef");
  });
});

describe("redactGitOutput", () => {
  it.each([
    "https://user:ghp_tokenvalue@github.com/o/r",
    "Authorization: Bearer ghp_tokenvalue",
    "https://github.com/login/oauth?access_token=ghp_tokenvalue",
  ])("removes credentials from %s", (input) => {
    expect(redactGitOutput(input)).not.toContain("ghp_tokenvalue");
  });

  it("leaves ordinary git output untouched", () => {
    const output = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\trefs/heads/main";
    expect(redactGitOutput(output)).toBe(output);
  });
});
