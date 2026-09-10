import type { RemoteProbeFailureReason } from "../protocol/checkpoint.js";
import type { GitHubRepositoryKey } from "../protocol/repo.js";
import type { FullCommitSha } from "../protocol/sha.js";
import { isFullCommitSha } from "../protocol/sha.js";

/**
 * Minimal read-only GitHub REST access for checkpoint facts (INV-04, INV-05).
 *
 * Two rules shape this module:
 *
 * 1. **Read-only.** Only `GET` exists here. The adviser's source context travels through GitHub and
 *    the extension never writes to it, so a write method would be a standing invitation to break
 *    INV-05 from inside a helper function.
 * 2. **Honest failures.** Every non-success is mapped to a protocol reason, and an ambiguous answer
 *    stays ambiguous. A token that cannot see a private repository produces the same 404 as a commit
 *    that was never pushed; reporting the second from the first would tell the user to push work that
 *    is already public.
 */

/** Minimal `fetch` surface, so tests inject a fake and callers can pass any implementation. */
export type GitHubFetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal },
) => Promise<GitHubFetchResponse>;

export type GitHubFetchResponse = {
  readonly status: number;
  readonly ok: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export type GitHubProbeFailure = {
  readonly reason: RemoteProbeFailureReason;
  /** Operator-facing detail. Never contains the token or a response body verbatim. */
  readonly detail: string;
};

export type GitHubOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: GitHubProbeFailure };

/** Answer to "is this exact object published?". `inconclusive` is a real, common answer. */
export type ObjectPresence = "present" | "absent" | "inconclusive";

export type PullRequestSummary = {
  readonly number: number;
  readonly headSha: FullCommitSha;
  readonly baseRefName: string;
};

export interface GitHubApi {
  checkCommitPresence(repository: GitHubRepositoryKey, commit: FullCommitSha): Promise<GitHubOutcome<ObjectPresence>>;
  listOpenPullRequestsForHead(
    repository: GitHubRepositoryKey,
    headRef: string,
  ): Promise<GitHubOutcome<readonly PullRequestSummary[]>>;
}

export interface GitHubApiOptions {
  readonly fetchImpl: GitHubFetch;
  /**
   * Injected by the caller that owns the credential (M2). This module never reads environment
   * variables or files, so it cannot become an accidental credential reader.
   */
  readonly token: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

function failure(reason: RemoteProbeFailureReason, detail: string): GitHubProbeFailure {
  return { reason, detail };
}

/**
 * Remove credential material from anything that may reach an error or diagnostic (INV-12).
 *
 * Server-side input is untrusted: an error body that echoes the request can carry the token back
 * into a UI string or a ledger record.
 */
export function redactGitHubSecrets(text: string, token: string): string {
  let redacted = text;
  if (token.length >= 4) redacted = redacted.split(token).join("[redacted]");
  return redacted
    .replace(/authorization\s*:\s*bearer\s+\S+/giu, "authorization: Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)[A-Za-z0-9_-]{6,}/gu, "[redacted]")
    // A response body is never quoted verbatim; keeping this cap limits accidental log exfiltration.
    .slice(0, 400);
}

function ownerAndRepo(repository: GitHubRepositoryKey): { owner: string; repo: string } {
  const [owner = "", repo = ""] = repository.split("/");
  return { owner, repo };
}

export function createGitHubApi(options: GitHubApiOptions): GitHubApi {
  const baseUrl = (options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = options.token;

  async function get(path: string): Promise<GitHubOutcome<unknown>> {
    // TLS only: this header is a bearer credential and must never travel over a plain connection.
    if (!baseUrl.startsWith("https://")) {
      return {
        ok: false,
        failure: failure("github-auth-failed", `Refusing to send a bearer token to ${baseUrl}`),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await options.fetchImpl(`${baseUrl}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "pi-with-chatgpt",
          "x-github-api-version": "2022-11-28",
        },
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        // Rate limiting is also an authorization-class problem for our purposes: we cannot verify.
        const isRateLimited = response.headers?.["x-ratelimit-remaining"] === "0";
        return {
          ok: false,
          failure: failure(
            "github-auth-failed",
            isRateLimited
              ? "GitHub rate limit exhausted (HTTP 403); the checkpoint could not be verified."
              : `GitHub rejected the configured credentials (HTTP ${response.status}).`,
          ),
        };
      }
      if (!response.ok) return { ok: true, value: { httpStatus: response.status } };

      return { ok: true, value: await response.json() };
    } catch (error) {
      if (isAbort(error)) {
        return { ok: false, failure: failure("probe-timeout", `GitHub request timed out after ${timeoutMs}ms.`) };
      }
      return {
        ok: false,
        failure: failure("network-unreachable", redactGitHubSecrets(describe(error), token)),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkCommitPresence(
    repository: GitHubRepositoryKey,
    commit: FullCommitSha,
  ): Promise<GitHubOutcome<ObjectPresence>> {
    const path = `/repos/${encoded(repository)}/commits/${encodeURIComponent(commit)}`;
    const response = await get(path);
    if (!response.ok) return response;

    const status = httpStatusOf(response.value);
    if (status === undefined) return { ok: true, value: "present" };
    if (status === 404) return await disambiguateNotFound(repository, token);
    return {
      ok: false,
      failure: failure("probe-inconclusive", `GitHub returned HTTP ${status} for the commit probe.`),
    };
  }

  /**
   * A 404 on an object is only "absent" when the repository itself is visible to this token.
   * Otherwise the two causes are indistinguishable and must be reported as such.
   */
  async function disambiguateNotFound(
    repository: GitHubRepositoryKey,
    secret: string,
  ): Promise<GitHubOutcome<ObjectPresence>> {
    const repositoryResponse = await get(`/repos/${encoded(repository)}`);
    if (!repositoryResponse.ok) {
      // Propagate the underlying auth/network cause, which is more actionable than "inconclusive".
      void secret;
      return repositoryResponse;
    }
    const status = httpStatusOf(repositoryResponse.value);
    if (status === undefined) return { ok: true, value: "absent" };
    if (status === 404) {
      return {
        ok: false,
        failure: failure(
          "probe-inconclusive",
          "The repository itself is not visible with the configured token, so a missing commit cannot be distinguished from a private repository.",
        ),
      };
    }
    return {
      ok: false,
      failure: failure("probe-inconclusive", `GitHub returned HTTP ${status} while checking the repository.`),
    };
  }

  async function listOpenPullRequestsForHead(
    repository: GitHubRepositoryKey,
    headRef: string,
  ): Promise<GitHubOutcome<readonly PullRequestSummary[]>> {
    const { owner } = ownerAndRepo(repository);
    const path =
      `/repos/${encoded(repository)}/pulls?state=open&per_page=100` +
      `&head=${encodeURIComponent(`${owner}:${headRef}`)}`;
    const response = await get(path);
    if (!response.ok) return response;

    const status = httpStatusOf(response.value);
    if (status !== undefined) {
      return {
        ok: false,
        failure: failure("probe-inconclusive", `GitHub returned HTTP ${status} for the PR probe.`),
      };
    }

    return { ok: true, value: parsePullRequestList(response.value) };
  }

  return { checkCommitPresence, listOpenPullRequestsForHead };
}

/**
 * Parse the PR list defensively.
 *
 * GitHub's payload is untrusted input with a schema we do not control; a field that is missing or
 * the wrong type drops that entry rather than throwing, because a dropped PR only loses advisory
 * context while an exception loses the whole consultation.
 */
export function parsePullRequestList(payload: unknown): readonly PullRequestSummary[] {
  if (!Array.isArray(payload)) return [];
  const summaries: PullRequestSummary[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const number = record["number"];
    const head = record["head"];
    if (typeof number !== "number" || typeof head !== "object" || head === null) continue;
    const headSha = (head as Record<string, unknown>)["sha"];
    if (typeof headSha !== "string" || !isFullCommitSha(headSha)) continue;
    const base = record["base"];
    const baseRef =
      typeof base === "object" && base !== null
        ? (base as Record<string, unknown>)["ref"]
        : undefined;
    summaries.push({
      number,
      headSha,
      baseRefName: typeof baseRef === "string" ? baseRef : "",
    });
  }
  return summaries;
}

function encoded(repository: GitHubRepositoryKey): string {
  const { owner, repo } = ownerAndRepo(repository);
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** Sentinel shape for a non-OK HTTP response that still needs per-endpoint interpretation. */
function httpStatusOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const status = (value as Record<string, unknown>)["httpStatus"];
  return typeof status === "number" ? status : undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
