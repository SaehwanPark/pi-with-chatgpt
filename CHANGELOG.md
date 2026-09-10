# Changelog

All notable changes to `pi-with-chatgpt` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is updated in the same commit as the change it describes, together with any docs that
change invalidates (see `AGENTS.md`).

## [Unreleased]

### Added — M0 (repository and architecture foundation)

- Toolchain and package: `package.json` for `pi-with-chatgpt` (ESM, `engines.node >= 22.19.0`,
  Pi package manifest with `pi.extensions = ./dist/extension/index.js` and the `pi-package`
  keyword), `tsconfig.json`/`tsconfig.build.json`, ESLint flat config, Vitest config, MIT `LICENSE`,
  and CI (`ci/ci.yml`, staged outside `.github/workflows/` until a credential with the `workflow`
  scope is available — see `ci/README.md`) on `ubuntu-latest` + `macos-latest`.
- The eleven planned module trees — `extension/ git/ auth/ browser/ chatgpt/ jobs/ protocol/
  ledger/ drift/ config/ ui/` — each with a documented barrel.
- Architecture invariants INV-01…INV-16 written down in `docs/ARCHITECTURE.md` and indexed as data
  in `protocol/invariants.ts`; enforced by typed boundaries and guards in `protocol/`, `git/`,
  `auth/`, `browser/`, `chatgpt/`, `jobs/`, `ledger/`, `config/`, and `ui/`.
- Zero-side-effect Pi activation (`extension/index.ts`) with a smoke test that installs the package
  into an isolated Pi root and asserts that nothing is registered (`test/pi-smoke.mjs`).
- Security contract `docs/SECURITY.md` (trust boundaries, credential containment, prompt-injection
  posture) and module-boundary tests (`test/module-boundaries.test.ts`).
- 160 unit tests across 18 files.

### Hardened after invariant review (M0)

- `assertPersistenceOrder` fails closed when a persistence step is missing instead of treating an
  omission as "nothing to check" (INV-15).
- `git/authority.ts` now refuses arguments that write files or execute programs on otherwise read-only
  subcommands (`--output`, `--ext-diff`, `--textconv`, `--paginate`, `--upload-pack`,
  `--receive-pack`, `--exec-path`, `--git-dir`, `--work-tree`, `-c`, `-C`, …) (INV-06).
- `parseGitHubRemote` refuses credential-bearing remote URLs with `credentials-in-url` instead of
  silently canonicalising them (INV-12); conversation keys percent-encode the task id so a task id
  containing `:` cannot imitate another conversation (INV-09).
- Project-scope configuration cannot set `dependencyDefault: "required"`: blocking on adviser
  availability stays a user-level decision (INV-07).
- `draft`/`queued` may transition to `failed` (preflight and dispatch preconditions fail before the
  job ever runs); ledger scanning also rejects PEM private-key blocks.
- Docs corrected: `docs/SECURITY.md` invariant table now cites real symbols and the correct invariant
  ids, `docs/ARCHITECTURE.md` invariant headings are addressable anchors, and `AGENTS.md` records the
  fixed toolchain instead of the pre-M0 "specification-only / bun vs npm" wording.

### Added — M1 (Git/GitHub checkpoint subsystem)

- `git/exec.ts`: the only place this subsystem spawns git. Enforces the read-only allowlist before
  spawn, runs non-interactive and locale/timezone-neutral (`GIT_TERMINAL_PROMPT=0`,
  `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_LFS_SKIP_SMUDGE=1`, `GIT_PAGER=cat`, `LC_ALL=C`,
  `TZ=UTC`), kills on a bounded timeout, never passes a shell, and redacts user info, passwords,
  URL-embedded credentials, GitHub tokens, and Authorization headers out of the error text that
  reaches a worker transcript. Raw stdout/stderr is never returned on failure because git quotes the
  command it failed on, and the ref the worker supplied is attacker-influenced text.
- `git/repository.ts` (repository/HEAD/worktree/shallow/dirt/remote inspection, deterministic GitHub
  remote selection with `upstream` beating `origin` for forks), `git/ref-resolution.ts` (ref → full
  commit SHA, with structural ref validation before the value reaches git), and `git/ancestry.ts`
  (ahead / behind / diverged / unrelated, treating "could not compare" as its own answer).
- `git/remote-availability.ts` + `git/checkpoint-resolution.ts`: the INV-04 decision. Availability is
  answered by whether the exact commit object is readable on the selected GitHub remote; a missing
  object, an unreadable remote, an unsupported host, a non-GitHub remote, and a failed probe stay
  distinct, and only "available" permits dispatch. Unknown failures are never collapsed into "absent",
  because "not pushed yet" and "we could not tell" produce opposite and equally harmful worker advice.
- `git/github-api.ts` implements `GET` and nothing else; `listOpenPullRequestsForHead` returns
  `inconclusive` rather than "no pull request" for anything it cannot rule out, including 404 (which
  GitHub also returns for a private repository the token cannot see). `redactGitHubSecrets` is the
  shared token scrubber and the constructor of `GitHubApiError` is the one place it is guaranteed to run.
- `git/pr-detection.ts`: open-PR detection and PR-head drift as advisory metadata. `hasOpenPr === false`
  is asserted only when the lookup was conclusive; an anchor never moves because a PR head moved.
- `git/checkpoint-resolution.ts:resolveCheckpoint` is the pipeline the extension layer will call: total,
  structured, non-throwing, and it spends API calls on PR metadata only for a consultation that is
  actually being dispatched.
- `docs/CHECKPOINT_PROTOCOL.md`: repository/remote selection, the five-case availability table, git
  safety, and the stable consultation identity.
- 137 new tests in `git/` plus `test/git-integration.test.ts`, which drives real git repositories
  (linked worktrees, shallow clones, detached HEAD, tag and abbreviated resolution, divergence, and a
  real `file://` force-push) so allowlist spellings and porcelain formats are confirmed against real git
  rather than only against fixtures.

### Changed

- Toolchain fixed to TypeScript + Node 22 + npm + vitest (previously "to be fixed in M0");
  `README.md` development commands updated from the provisional `bun` examples.
- Roadmap M0 and M1 checkboxes ticked with a named artifact/test per item.
- INV-04 is no longer a deferred guard: `protocol/invariants.ts` points at
  `git/remote-availability.ts` + `git/checkpoint-resolution.ts`, leaving INV-14 (M6 prompt assembler)
  as the only planned guard. `docs/ARCHITECTURE.md` INV-04 is marked implemented.
- `protocol/checkpoint.ts` gains `"probe-inconclusive"`: a probe that completed without a decisive
  answer is neither a verdict about the commit nor a transport failure.

### Not yet implemented

No adviser behaviour yet: authentication (M2), browser automation (M3–M4), consultation protocol
(M5–M7), commands/UI (M8), and hardening/release (M9–M10). Until then the extension registers no
commands and no tools, by design. The checkpoint subsystem exists but nothing calls it yet, and
`GitHubApi.fetch` still defaults to `globalThis.fetch`, which M9 replaces with a key-redacting
wrapper before any token can meet a redirected request.
