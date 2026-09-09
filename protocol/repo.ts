/**
 * Canonical GitHub repository identity.
 *
 * `owner/repo` is the key for the one-Project-per-repository mapping (INV-08), so it must be
 * stable across remote URL spellings (SSH vs HTTPS), trailing `.git`, and case: GitHub treats the
 * owner and repository name case-insensitively for lookup, and a key that varied by spelling would
 * create duplicate Projects for one repository.
 */

export interface GitHubRemoteUrl {
  readonly owner: string;
  readonly repo: string;
}

/** Branded canonical `owner/repo` key (lowercased, no `.git`, no host). */
export type GitHubRepositoryKey = string & { readonly __brand: "GitHubRepositoryKey" };

export type GitHubRemoteRejection =
  | "not-a-github-remote"
  | "unsupported-host"
  /** The remote has no usable `owner/repo` path. */
  | "malformed-path";

const GITHUB_HOSTS = ["github.com", "www.github.com"] as const;

/**
 * V1 is GitHub-only (INV-02, INV-16). Additional hosts are a post-V1 decision, so this list is
 * deliberately not configurable: a GitLab or self-hosted GHE host must fail loudly instead of
 * silently becoming a second source transport.
 */
export function supportedGitHubHosts(): readonly string[] {
  return GITHUB_HOSTS;
}

export interface GitHubRemoteParseResult {
  readonly ok: boolean;
  readonly key?: GitHubRepositoryKey;
  readonly owner?: string;
  readonly repo?: string;
  readonly rejection?: GitHubRemoteRejection;
}

/**
 * Parse the scp-like (`git@host:owner/repo.git`), SSH URL, and HTTPS URL spellings git produces.
 * Full detection and remote *selection* is M1; this is the canonicalisation the key depends on.
 */
export function parseGitHubRemote(remoteUrl: string): GitHubRemoteParseResult {
  const trimmed = remoteUrl.trim().replace(/\/+$/, "");
  const path = scpLikePath(trimmed) ?? schemePath(trimmed);
  if (path === undefined) return { ok: false, rejection: "not-a-github-remote" };

  const [host, repoPath] = path;
  if (host === undefined || repoPath === undefined) return { ok: false, rejection: "not-a-github-remote" };
  if (!isSupportedHost(host)) return { ok: false, rejection: "unsupported-host" };

  const segments = repoPath.replace(/\.git$/, "").split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return { ok: false, rejection: "malformed-path" };
  const owner = segments[0]!;
  const repo = segments[1]!;
  if (owner.length === 0 || repo.length === 0) return { ok: false, rejection: "malformed-path" };

  return { ok: true, key: canonicalRepositoryKey(owner, repo), owner, repo };
}

export function canonicalRepositoryKey(owner: string, repo: string): GitHubRepositoryKey {
  return `${owner.toLowerCase()}/${repo.toLowerCase().replace(/\.git$/, "")}` as GitHubRepositoryKey;
}

function isSupportedHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (GITHUB_HOSTS as readonly string[]).includes(normalized);
}

/** `git@github.com:owner/repo.git` and `ssh://git@github.com/owner/repo.git`. */
function scpLikePath(url: string): [string, string] | undefined {
  const sshScheme = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(url);
  if (sshScheme?.[1] !== undefined && sshScheme[2] !== undefined) return [sshScheme[1], sshScheme[2]];

  const scpLike = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(url);
  if (scpLike?.[1] !== undefined && scpLike[2] !== undefined && !scpLike[2].startsWith("/")) {
    return [scpLike[1], scpLike[2]];
  }
  return undefined;
}

/** `https://github.com/owner/repo.git` (credentials in the URL are rejected, never used). */
function schemePath(url: string): [string, string] | undefined {
  const match = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(url);
  if (match?.[1] !== undefined && match[2] !== undefined) return [match[1], match[2]];
  return undefined;
}
