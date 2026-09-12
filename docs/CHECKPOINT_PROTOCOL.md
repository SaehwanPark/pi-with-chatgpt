# Checkpoint Protocol

How `pi-with-chatgpt` turns "where am I in the code right now" into an anchor that a remote adviser
can be trusted against, and what it refuses to do on the way there.

Authority for the invariants named here: `docs/ARCHITECTURE.md` (INV-02, INV-03, INV-04, INV-06,
INV-12), machine-readable index in `protocol/invariants.ts`. Implementation lives in `git/` and
`protocol/`; the consultation protocol document (M5/M6) will describe what happens once an anchor exists.

## 1. Why a checkpoint at all

ChatGPT is consulted through a browser. It has no filesystem, so the only repository state it can
actually read is what GitHub shows. That makes an *immutable, remotely inspectable commit* the one
honest coordinate system for a consultation:

- the adviser and the worker look at the same code, by construction;
- the anchor survives history changes (`main` moves, the branch is rebased, the PR is updated);
- a later drift report can state exactly how far the working tree has moved from what the adviser saw;
- nothing has to be uploaded, archived, or tunnelled — which is the whole security posture (INV-02).

## 2. Resolution

```
requestedRef ──▶ resolve ──▶ resolvedCommit (full 40-hex SHA) ──▶ probe remote ──▶ anchor
   (kept)                          (never alone)                    (INV-04)
```

| Input | Handling |
| --- | --- |
| `HEAD` | resolved through `git rev-parse --verify --quiet HEAD^{commit}` |
| branch (`main`, `feat/x`) | same; an unresolvable ref is a typed failure, never `HEAD` |
| tag | peeled to its commit object (`^{commit}`), so a tag anchor is still a SHA |
| full or abbreviated SHA | abbreviated SHAs are expanded; only the full SHA is persisted |
| `refs/pull/<n>/head` | allowed explicitly, so a PR-only contribution can be anchored |

Both values are persisted, always (`requestedRef` + `resolvedCommit`). Persisting only the resolution
destroys the audit trail of what was asked for; persisting only the ref makes the anchor a moving
part. `protocol/checkpoint.ts` keeps them as separate readonly fields, and `resolvedCommit` is a
branded `FullCommitSha` so a 7-character abbreviation is a type error rather than a bug report.

Refs are validated before they reach `git`: empty/whitespace-only refs, refs starting with `-`, and
refs containing control characters are refused with distinct reasons, because an argument that looks
like a flag is exactly how a "read-only" inspection becomes something else.

## 3. Repository and remote selection

- Repository root, branch (or detached HEAD), HEAD commit, worktrees, shallow status, and uncommitted
  changes are read with allowlisted read-only commands only (`git/authority.ts`).
- Remotes are parsed in all three spellings git produces — scp-like (`git@github.com:o/r.git`),
  `ssh://git@github.com/o/r.git`, and `https://github.com/o/r[.git]` — and canonicalised to the
  lowercase `owner/repo` key (`protocol/repo.ts`). That key is the one-Project-per-repository key
  (INV-08), so it must not vary by spelling.
- A remote whose URL embeds credentials (`https://<token>@github.com/...`) is **refused**, not
  silently cleaned: the URL is a credential container and quietly discarding part of it is how
  secrets end up in a derived field (INV-12).
- Selection among several GitHub remotes starts deterministically (`origin`, then `upstream`, then
  the lexicographically first GitHub remote) and is reported. If that candidate does not prove the
  exact checkpoint is present, the remaining GitHub candidates are probed in deterministic order;
  the first candidate containing the checkpoint becomes authoritative. This covers fork/upstream
  publication layouts without treating a remote name as push authority.
- Non-GitHub and unsupported hosts are rejected with the parse reason attached. V1 is GitHub-only
  (INV-16): a GitLab or GHE host must fail loudly rather than become a second transport.
- No GitHub remote at all is a structured `repository-not-pushed`-class result, not an exception with
  git's exit-128 text.

## 4. Remote availability (INV-04)

Before any browser work, the checkpoint is probed. The probe distinguishes:

| Situation | `RemoteAvailability` | Dispatch |
| --- | --- | --- |
| commit is on the selected remote | `available` | yes |
| commit exists only locally | `unavailable / commit-not-on-remote` | **no** |
| local branch has commits the remote lacks | `unavailable / branch-ahead-of-remote` | **no** |
| local and remote histories diverged | `unavailable / branch-diverged-from-remote` | **no** |
| repository never pushed / remote branch absent | `unavailable / repository-not-pushed` | **no** |
| network failure, timeout, auth failure, no remote configured | `unknown / <probe failure>` | **no** |
| probe completed but the answer is ambiguous | `unknown / probe-inconclusive` | **no** |

The decisive question — "can GitHub show me *this exact object*?" — is answered by a read-only
`GET /repos/{owner}/{repo}/commits/{sha}` (`git/github-api.ts`, which implements `GET` and nothing
else). The local remote-tracking ref is used only as secondary evidence for telling "ahead" from
"diverged", and it is explicitly the last-fetched state: this subsystem never runs `git fetch`,
because fetching writes refs and the read-only allowlist says so.

The exact-object request may be anonymous when no GitHub credential is configured; that preserves
verification for public repositories without inventing an authentication result. A public 404 is
disambiguated with a repository visibility request, while a repository that cannot be verified stays
`unknown`. The production adapter never synthesizes `present` when the probe was not performed.

An uncommitted working tree never changes this table: the checkpoint is committed history, and a dirty tree says nothing about whether that history is published.

Two rules make this list worth having:

1. **`unknown` is not `available`.** `checkDispatchReadiness` refuses anything that is not exactly
   `available`, so a flaky network or an under-scoped token cannot smuggle a consultation whose
   provenance nobody verified. A failed probe is reported as a failed probe.
2. **A 404 is not proof of absence.** A private repository queried with a token that cannot see it
   also returns 404, so "not on the remote" is only concluded when the repository itself was visible.
   Otherwise the result stays `unknown`.

**Uncommitted work is a different axis.** The checkpoint is the last *committed* state; a dirty
working tree does not change whether that commit is reachable on the remote, so availability does not
flip. It is reported separately as a working-tree drift advisory (`workingTreeDrift` on the
assessment, plus a capped `dirtyPathsSample`): the adviser will read the pushed commit, not your
uncommitted edits, and the worker decides whether that is the right thing to consult about. The
extension never stages or commits to "fix" this.

## 5. PR metadata is advisory

When the branch corresponds to an open pull request, the PR number is stored alongside the anchor as
context, together with the PR head SHA observed at resolution time. The anchor itself remains the
SHA:

- the PR is looked up only for a consultation that is actually being dispatched — a refused
  checkpoint does not spend API calls on metadata nobody will read;
- several open PRs on one head (several base branches) resolve deterministically to the lowest PR
  number, flagged as ambiguous rather than silently picked;
- when the PR head later moves, the stored anchor is **not** retargeted; the drift layer reports the
  mismatch (`pr-head-moved`) and the worker decides whether the advice is still usable.

This is INV-03 in practice: an active or completed consultation never silently follows a moving ref,
because the point of advice is that you can tell what it was about.

## 6. Git safety on this path (INV-06)

The consultation path may only inspect. `git/authority.ts` is an allowlist of exact read-only
invocations plus a forbidden-argument list, enforced in `git/exec.ts` before a process is spawned:

- arguments that write files (`log --output=…`, `diff --ext-diff`) or execute programs
  (`ls-remote --upload-pack=…`, `git -c core.pager=…`) are refused even under a read-only subcommand;
- `git add -A` never exists on this path — nothing in the checkpoint subsystem stages anything, and
  there is no code path where an adviser request turns into a commit or a push;
- committing or pushing requires a `GitAuthorityToken` that only explicit user confirmation produces
  (M8); a remote named `origin` is never such a token;
- git runs with `GIT_TERMINAL_PROMPT=0` (no interactive credential prompts), `GIT_PAGER=cat`,
  `GIT_OPTIONAL_LOCKS=0` (a read-only probe does not take a lock a human is waiting on), and
  `GIT_CONFIG_NOSYSTEM=1` (a system-wide `url.<base>.insteadOf` may not silently retarget a remote);
- the executor supplies high-precedence config disabling `core.fsmonitor` and `diff.external`, so
  repository-local read-only inspection cannot execute configured helper programs;
- process output is redacted of credential-shaped material before it becomes an error message, an
  interface string, or adviser context (INV-12). That covers URL userinfo with **or without** a colon
  (`https://<token>@github.com/o/r`, which git echoes back verbatim) and GitHub token shapes
  (`ghp_…`, `github_pat_…`) wherever they appear;
- flags that would opt a single invocation into config-declared programs (`--ext-diff`, `--textconv`,
  `-p`/`--paginate`, `--upload-pack`, `-c`) are refused outright; the executor also neutralizes the
  repo-local `core.fsmonitor` and `diff.external` settings for the remaining read-only commands.

The GitHub half of the probe has its own envelope, because it decides dispatch and holds a bearer
token: the API **hostname is pinned** (`ALLOWED_GITHUB_API_HOSTS`, default `api.github.com`; a
reviewed GitHub Enterprise host is an explicit `allowedHosts` option) and an unallowed or non-https
base URL throws at construction rather than returning a failure a caller might paper over; requests
use `redirect: "manual"` so the token is never replayed to a redirect target, which makes a 3xx an
inconclusive probe instead of a second request; `owner` and `repo` are percent-encoded into the path,
so no repository string can traverse out of `/repos/…`; and the client issues `GET` and nothing else.

When the checkpoint is not remote, the worker receives a structured result and handles it under its
**normal** git permissions: it is told the commit, the remote, the reason, and that pushing is its
own decision to make with its own tools.

## 7. The stable consultation identity

What M1 promises as output, and what every later layer keys on:

```ts
type ConsultationAnchor = {
  repository: GitHubRepositoryKey;      // canonical owner/repo (INV-08 key)
  remoteUrl: string;                     // selected remote, canonicalised
  requestedRef: string;                  // what was asked for
  resolvedCommit: FullCommitSha;         // the anchor (INV-03)
  pullRequest?: { number, headCommit };  // advisory only
  remoteAvailability: RemoteAvailability;// INV-04 verdict, `unknown` ≠ available
};
```

The working branch name stays with the resolution's working-state context so a human reading the
ledger knows what was open at the time, but it is not part of identity: the branch may be deleted,
renamed, or rebased while the advice is still being applied.

The returned anchor is `Object.freeze`'d as well as `readonly`. `readonly` protects the next
compiler; freezing protects the value, because an anchor rewritten in place mid-consultation silently
changes what previously delivered advice meant.

## 8. Module map

| File | Responsibility |
| --- | --- |
| `git/exec.ts` | the only git entry point; allowlist enforced before spawn, credential redaction on the way out |
| `git/authority.ts` | read-only invocation allowlist + forbidden-argument list (INV-06) |
| `git/repository.ts` | repository, HEAD, worktree, shallow, dirt, and remote inspection; deterministic remote selection |
| `git/ref-resolution.ts` | ref → full commit SHA, with structural ref validation |
| `git/ancestry.ts` | ahead / behind / diverged / unrelated, with `undefined` kept distinct from `false` |
| `git/remote-availability.ts` | the pure INV-04 decision and its user-facing explanation |
| `git/github-api.ts` | read-only GitHub queries; honest `inconclusive` handling; token containment |
| `git/pr-detection.ts` | advisory PR metadata and PR-head drift |
| `git/checkpoint-resolution.ts` | the pipeline the extension layer calls; total, structured, non-throwing |
