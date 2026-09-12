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
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    /** Always `"manual"`: the bearer token must not be replayed to a redirect target. */
    readonly redirect: "manual";
  },
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

/**
 * The only API host a token may be sent to by default.
 *
 * This is not transport hygiene, it is INV-04: the host that answers `GET /repos/…/commits/<sha>`
 * is the authority that decides whether a consultation is dispatched, and it is also the host that
 * receives a bearer credential. A caller-configurable `baseUrl` without a pinned host would let a
 * typo, a malicious repo-local config, or a confused GHES setting turn "GitHub said this commit is
 * published" into "some server said so". `protocol/repo.ts` accepts `github.com` remotes only in V1,
 * so `api.github.com` is the only honest default; GitHub Enterprise is an explicit, reviewed opt-in.
 */
export const ALLOWED_GITHUB_API_HOSTS: readonly string[] = ["api.github.com"];

/** Thrown when a client cannot be built safely. Construction fails loudly instead of degrading. */
export class GitHubApiConfigurationError extends Error {
  constructor(detail: string) {
    super(`GitHub API client configuration refused: ${detail}`);
    this.name = "GitHubApiConfigurationError";
  }
}

/**
 * Reject a base URL that would send the bearer token somewhere untrusted.
 *
 * Checked at construction: a client that cannot be safe should not exist long enough to be called.
 */
export function assertSafeGitHubApiBaseUrl(
  baseUrl: string,
  allowedHosts: readonly string[] = ALLOWED_GITHUB_API_HOSTS,
): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new GitHubApiConfigurationError(`"${baseUrl}" is not an absolute URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new GitHubApiConfigurationError(
      `"${baseUrl}" is not https; a bearer token must never travel in clear text.`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new GitHubApiConfigurationError("credentials in the API base URL are refused.");
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new GitHubApiConfigurationError(
      `host "${parsed.hostname}" is not an allowed GitHub API host (${allowedHosts.join(", ")}).`,
    );
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    // A path prefix is how GitHub Enterprise roots its API; it is allowed only for an allowed host.
    return normalized;
  }
  return normalized;
}

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
   * variables or files, so it cannot become an accidental credential reader. When omitted (or
   * blank), requests are anonymous; a public repository can still be verified, while private or
   * otherwise unverifiable results remain inconclusive.
   */
  readonly token?: string;
  readonly baseUrl?: string;
  /**
   * Hosts permitted to receive the token. Only meaningful for a reviewed GitHub Enterprise
   * deployment; leaving it unset keeps the V1 default of `api.github.com` alone.
   */
  readonly allowedHosts?: readonly string[];
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
export function redactGitHubSecrets(text: string, token?: string): string {
  let redacted = text;
  if (token !== undefined && token.length >= 4) redacted = redacted.split(token).join("[redacted]");
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
  // Validated before anything can be called: the host is part of the security envelope, not a URL
  // detail, so an unsafe configuration throws rather than returning a failure that a caller might
  // paper over.
  const baseUrl = assertSafeGitHubApiBaseUrl(
    options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL,
    options.allowedHosts ?? ALLOWED_GITHUB_API_HOSTS,
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // An empty environment value is equivalent to no credential. Sending `Bearer ` would turn a
  // public-repository probe into an avoidable authentication failure and is not anonymous access.
  const token = options.token?.trim() === "" ? undefined : options.token;

  async function get(path: string): Promise<GitHubOutcome<unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "user-agent": "pi-with-chatgpt",
        "x-github-api-version": "2022-11-28",
      };
      if (token !== undefined) headers.authorization = `Bearer ${token}`;

      const response = await options.fetchImpl(`${baseUrl}${path}`, {
        headers,
        signal: controller.signal,
        // Manual redirects: `Authorization` is a bearer credential, and following a redirect would
        // replay it to whatever host GitHub points at. A 3xx is therefore not an answer about the
        // checkpoint, so it surfaces as an inconclusive probe rather than a silent second request.
        redirect: "manual",
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
    if (status === 404) return await disambiguateNotFound(repository);
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
  ): Promise<GitHubOutcome<ObjectPresence>> {
    const repositoryResponse = await get(`/repos/${encoded(repository)}`);
    if (!repositoryResponse.ok) {
      // Propagate the underlying auth/network cause, which is more actionable than "inconclusive".
      return repositoryResponse;
    }
    const status = httpStatusOf(repositoryResponse.value);
    if (status === undefined) return { ok: true, value: "absent" };
    if (status === 404) {
      return {
        ok: false,
        failure: failure(
          "probe-inconclusive",
          "The repository itself is not visible to the GitHub request, so a missing commit cannot be distinguished from a private repository.",
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
