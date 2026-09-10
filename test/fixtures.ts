/**
 * Shared fixtures for tests. Values are produced through the same parsing functions production code
 * uses, so a test cannot accidentally assert against an identity the runtime would reject.
 */

import type { ConsultationId } from "../protocol/checkpoint.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import type { LedgerRecord } from "../ledger/record.js";
import type { GitExecutor } from "../git/exec.js";

export const CHECKPOINT_SHA = requireFullCommitSha("0f2c8f4a1d6b4f1e9c2d8e6a5b4c3d2e1f0a9b8c");
export const OTHER_CHECKPOINT_SHA = requireFullCommitSha("1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d");
export const REPO_KEY = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");

/** Consultation ids are allocated by the job engine (M5); tests use a syntactically valid one. */
export const CONSULTATION_ID = "adv-4f2a-1" as ConsultationId;

export function ledgerRecord(overrides: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    consultationId: CONSULTATION_ID,
    kind: "review",
    dependency: "advisory",
    repository: REPO_KEY,
    requestedRef: "HEAD",
    resolvedCommit: CHECKPOINT_SHA,
    state: "completed",
    requestBrief: "review the checkpoint resolution for drift handling",
    adviserAnswer: "the anchor is resolved before dispatch; looks fine",
    actionItems: [{ ordinal: 1, summary: "add a divergence test", disposition: "pending" }],
    dispatchedAt: "2026-09-09T12:00:00.000Z",
    completedAt: "2026-09-09T12:00:31.000Z",
    ...overrides,
  };
}

/** Records carrying an extra field are a caller bug; the guard is what catches that, so tests need a way to try one. */
export function unsafeRecord(extra: Record<string, unknown>): LedgerRecord {
  return Object.assign({}, ledgerRecord(), extra);
}

/**
 * Fake git executor: maps an exact invocation (space-joined) to an outcome and records every call.
 *
 * Unhandled invocations throw rather than returning an empty success, because a silent default hides
 * the difference between "git said no" and "the production code asked something new" — the second is
 * an INV-06 question and must fail the test loudly.
 */
export type FakeGitOutcome = {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
};

export function fakeGit(handlers: Readonly<Record<string, FakeGitOutcome | string>>) {
  const invocations: string[][] = [];
  const outcomeOf = (invocation: readonly string[]): FakeGitOutcome => {
    const handler = handlers[invocation.join(" ")];
    if (handler === undefined) throw new Error(`unhandled git invocation: ${invocation.join(" ")}`);
    return typeof handler === "string" ? { code: 0, stdout: handler } : handler;
  };

  // Deliberately not `async`: an unknown invocation must reject like a rejected promise rather than
  // throw synchronously, which a caller could accidentally catch with `.catch`-less code.
  const attempt = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const executor: GitExecutor = {
    run(invocation, _cwd) {
      return attempt(() => {
        invocations.push([...invocation]);
        const outcome = outcomeOf(invocation);
        if ((outcome.code ?? 0) !== 0) {
          throw new Error(`git ${invocation.join(" ")} exited ${outcome.code}: ${outcome.stderr ?? ""}`);
        }
        return (outcome.stdout ?? "").trim();
      });
    },
    runAllowingFailure(invocation, _cwd) {
      return attempt(() => {
        invocations.push([...invocation]);
        const outcome = outcomeOf(invocation);
        return {
          code: outcome.code ?? 0,
          stdout: outcome.stdout ?? "",
          stderr: outcome.stderr ?? "",
        };
      });
    },
  };

  return { executor, invocations };
}
