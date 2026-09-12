import { describe, expect, it } from "vitest";

import { CHECKPOINT_SHA, REPO_KEY } from "../test/fixtures.js";
import {
  createGitHubApi,
  parsePullRequestList,
  redactGitHubSecrets,
  type GitHubFetch,
  type GitHubFetchResponse,
} from "./github-api.js";

const TOKEN = "ghp_supersecrettoken_0123456789";

type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  /** A simulated transport failure: the fake rejects with this error, like `fetch` would. */
  | { error: Error };

function fakeFetch(replies: Record<string, Reply>) {
  const requests: { url: string; headers: Record<string, string>; redirect?: string }[] = [];

  // Not `async`: an unmatched URL or a simulated transport error must reject, matching how the real
  // `fetch` reports them, and the linter should not have to pretend there is an await here.
  const fetchImpl: GitHubFetch = (url, init) => {
    requests.push({ url, headers: { ...init.headers }, redirect: init.redirect });
    const key = Object.keys(replies).find((candidate) => url.includes(candidate));
    if (key === undefined) return Promise.reject(new Error(`unhandled url: ${url}`));
    const reply = replies[key]!;
    if ("error" in reply) return Promise.reject(reply.error);

    const response: GitHubFetchResponse = {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      headers: reply.headers ?? {},
      json: () => Promise.resolve(reply.body ?? {}),
      text: () => Promise.resolve(JSON.stringify(reply.body ?? {})),
    };
    return Promise.resolve(response);
  };
  return { fetchImpl, requests };
}

function api(replies: Record<string, Reply>, options: { readonly timeoutMs?: number; readonly baseUrl?: string } = {}) {
  const { fetchImpl, requests } = fakeFetch(replies);
  return { api: createGitHubApi({ fetchImpl, token: TOKEN, ...options }), requests };
}

describe("createGitHubApi authentication", () => {
  it("probes public repositories anonymously when no credential is configured", async () => {
    const { fetchImpl, requests } = fakeFetch({
      "/commits/": { status: 200, body: { sha: CHECKPOINT_SHA } },
    });
    const client = createGitHubApi({ fetchImpl });

    await expect(client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA)).resolves.toEqual({
      ok: true,
      value: "present",
    });
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  it("does not turn a blank credential into an invalid bearer header", async () => {
    const { fetchImpl, requests } = fakeFetch({
      "/commits/": { status: 200, body: { sha: CHECKPOINT_SHA } },
    });
    const client = createGitHubApi({ fetchImpl, token: "   " });

    await expect(client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA)).resolves.toEqual({
      ok: true,
      value: "present",
    });
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  it("sends a bearer token over https with a read-only verb", async () => {
    const { api: client, requests } = api({ "/commits/": { status: 200, body: { sha: CHECKPOINT_SHA } } });

    await client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA);
    expect(requests[0]?.url).toBe(
      `https://api.github.com/repos/${REPO_KEY}/commits/${CHECKPOINT_SHA}`,
    );
    expect(requests[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("never follows a redirect, so the bearer token cannot be replayed to another host", async () => {
    const { api: client, requests } = api({ "/commits/": { status: 302 } });

    const outcome = await client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA);

    // One request only: a redirect target is never contacted, and a 3xx is not an answer about
    // whether the commit exists, so the caller must not be allowed to treat it as presence.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe("manual");
    // A redirect is reported as an inconclusive probe, which INV-04 refuses to dispatch on.
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.failure.reason).toBe("probe-inconclusive");
  });

  it("refuses to build a client for a non-TLS endpoint", () => {
    // Constructing throws: the refusal cannot be swallowed by a caller that ignores outcomes.
    const { fetchImpl } = fakeFetch({});
    expect(() =>
      createGitHubApi({ fetchImpl, token: TOKEN, baseUrl: "http://api.internal" }),
    ).toThrow(/not https/u);
  });

  it("refuses an API host that is not an allowed GitHub API host", () => {
    // Whoever answers the commit probe decides INV-04 dispatch, so the host is pinned, not inferred.
    const { fetchImpl } = fakeFetch({});
    expect(() =>
      createGitHubApi({ fetchImpl, token: TOKEN, baseUrl: "https://api.evil.example" }),
    ).toThrow(/not an allowed GitHub API host/u);
    expect(() =>
      createGitHubApi({ fetchImpl, token: TOKEN, baseUrl: "https://api.github.com.evil.example" }),
    ).toThrow(/not an allowed GitHub API host/u);
  });

  it("accepts a reviewed enterprise host only when explicitly allowed", () => {
    const { fetchImpl } = fakeFetch({});
    expect(() =>
      createGitHubApi({
        fetchImpl,
        token: TOKEN,
        baseUrl: "https://ghe.example.com/api/v3",
        allowedHosts: ["ghe.example.com"],
      }),
    ).not.toThrow();
  });

  it("refuses credentials embedded in the API base URL", () => {
    const { fetchImpl } = fakeFetch({});
    expect(() =>
      createGitHubApi({ fetchImpl, token: TOKEN, baseUrl: "https://oauth:@api.github.com" }),
    ).toThrow(/credentials in the API base URL/u);
  });

  it("never leaks the token through a configuration error message", () => {
    const { fetchImpl } = fakeFetch({});
    try {
      createGitHubApi({ fetchImpl, token: TOKEN, baseUrl: "https://api.evil.example" });
      expect.unreachable("expected configuration to be refused");
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});

describe("checkCommitPresence", () => {
  it("reports present on HTTP 200", async () => {
    const { api: client } = api({ "/commits/": { status: 200, body: { sha: CHECKPOINT_SHA } } });
    await expect(client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA)).resolves.toEqual({
      ok: true,
      value: "present",
    });
  });

  it("does not treat a successful payload for a different SHA as exact presence", async () => {
    const differentSha = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
    const { api: client } = api({ "/commits/": { status: 200, body: { sha: differentSha } } });

    const outcome = await client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.reason).toBe("probe-inconclusive");
  });

  it("reports absent only when the repository itself is visible", async () => {
    const { api: client, requests } = api({
      "/commits/": { status: 404, body: { message: "Not Found" } },
      [`/repos/${REPO_KEY}`]: { status: 200, body: { full_name: REPO_KEY } },
    });

    await expect(client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA)).resolves.toEqual({
      ok: true,
      value: "absent",
    });
    expect(requests).toHaveLength(2);
  });

  it("reports inconclusive when the repository is not visible either", async () => {
    // A private repository and a missing commit are indistinguishable from here; claiming "absent"
    // would tell the user to push work that is already public.
    const { api: client } = api({
      "/commits/": { status: 404, body: { message: "Not Found" } },
      "/repos/": { status: 404, body: { message: "Not Found" } },
    });

    const outcome = await client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.reason).toBe("probe-inconclusive");
  });

  it("maps 401 and 403 to github-auth-failed", async () => {
    for (const status of [401, 403]) {
      const { api: client } = api({ "/commits/": { status, body: { message: "Bad credentials" } } });
      const outcome = await client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.failure.reason).toBe("github-auth-failed");
    }
  });

  it("maps an exhausted rate limit to an actionable auth failure", async () => {
    const { api: client } = api({
      "/commits/": { status: 403, body: { message: "rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } },
    });

    const outcome = await client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.detail).toContain("rate limit");
  });

  it("maps a transport failure to network-unreachable", async () => {
    const { api: client } = api({ "/commits/": { error: new Error("getaddrinfo ENOTFOUND api.github.com") } });

    const outcome = await client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.reason).toBe("network-unreachable");
  });

  it("maps a hanging server to probe-timeout", async () => {
    const timeoutError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { api: client } = api({ "/commits/": { error: timeoutError } });

    const outcome = await client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.reason).toBe("probe-timeout");
  });

  it("reports an unexpected status as inconclusive rather than guessing", async () => {
    const { api: client } = api({ "/commits/": { status: 502, body: { message: "Bad gateway" } } });

    const outcome = await client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.reason).toBe("probe-inconclusive");
  });
});

describe("listOpenPullRequestsForHead", () => {
  it("requests the head-scoped open PR list", async () => {
    const { api: client, requests } = api({ "/pulls": { status: 200, body: [] } });

    await client.listOpenPullRequestsForHead(REPO_KEY, "main");
    expect(requests[0]?.url).toContain("/pulls?state=open");
    expect(requests[0]?.url).toContain(`head=${encodeURIComponent(`saehwanpark:main`)}`);
  });

  it("parses entries defensively and drops unusable ones", async () => {
    const { api: client } = api({
      "/pulls": {
        status: 200,
        body: [
          { number: 7, head: { sha: CHECKPOINT_SHA }, base: { ref: "main" } },
          { number: "eight", head: { sha: CHECKPOINT_SHA } },
          { number: 9, head: { sha: "not-a-sha" } },
          null,
        ],
      },
    });

    const outcome = await client.listOpenPullRequestsForHead(REPO_KEY, "main");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual([{ number: 7, headSha: CHECKPOINT_SHA, baseRefName: "main" }]);
  });

  it("surfaces a probe failure instead of throwing", async () => {
    const { api: client } = api({ "/pulls": { error: new Error("socket hang up") } });

    const outcome = await client.listOpenPullRequestsForHead(REPO_KEY, "main");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.reason).toBe("network-unreachable");
  });
});

describe("parsePullRequestList", () => {
  it("returns nothing for a non-array payload", () => {
    expect(parsePullRequestList({ message: "unexpected" })).toEqual([]);
    expect(parsePullRequestList(undefined)).toEqual([]);
  });
});

describe("redactGitHubSecrets", () => {
  it("removes the injected token and common token shapes", () => {
    const leaked = `failed with ${TOKEN} and ghp_abcdefghijklmnopqrstuvwxyz123456`;
    const redacted = redactGitHubSecrets(leaked, TOKEN);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });

  it("removes an echoed authorization header", () => {
    const redacted = redactGitHubSecrets(`Authorization: Bearer ${TOKEN}`, TOKEN);
    expect(redacted).not.toContain(TOKEN);
  });

  it("never leaks the token through a failure detail, even when the server echoes it", async () => {
    const { api: client } = api({
      "/commits/": { status: 500, body: { message: `token ${TOKEN} rejected` } },
    });

    const outcome = await client.checkCommitPresence(REPO_KEY, CHECKPOINT_SHA);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(JSON.stringify(outcome.failure)).not.toContain(TOKEN);
  });
});
