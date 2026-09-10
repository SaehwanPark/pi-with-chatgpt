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

### Hardened after invariant review (M1)

- `redactGitOutput` (INV-12) redacts URL userinfo with or without a colon — a token used as the URL
  username, which git echoes back in `fatal: Authentication failed for '…'` — plus `ghp_…`/`ghs_…`/
  `github_pat_…` token shapes and bare `bearer <token>` material.
- The GitHub API client pins the host that may receive the bearer token and decide INV-04 dispatch:
  `assertSafeGitHubApiBaseUrl` + `ALLOWED_GITHUB_API_HOSTS` reject a non-https, credential-bearing, or
  unallowed base URL by throwing at construction (GitHub Enterprise is an explicit `allowedHosts`
  opt-in), and requests use `redirect: "manual"` so a bearer token is never replayed to a redirect
  target (a 3xx is an inconclusive probe, not an answer).
- `aheadBehind` takes `base`/`head` instead of positional `left`/`right` and documents which side is
  "ahead": the previous naming invited an inverted count, which tells the user to push when the branch
  is actually behind.
- Checkpoint refs reject the whole C0/C1 control-character range and U+2028/U+2029 (not just CR/LF/TAB/
  NUL/backtick), and every echoed ref goes through `sanitizeRefForDisplay`, so a refusal string cannot
  forge terminal output (INV-12).
- `git/authority.ts` also refuses `-p` (short `--paginate`, runs `core.pager`), `--exec`, and
  `--push`.
- Docs: `docs/SECURITY.md` gains the Extension → GitHub API trust boundary and an INV-04 row;
  `docs/CHECKPOINT_PROTOCOL.md` documents the probe's network envelope; `docs/ARCHITECTURE.md` INV-04
  no longer says the probe "lands in M1"; the roadmap's M0 invariant note records the INV-04 promotion.

### Added — M2 (OpenAI identity and isolated ChatGPT authentication)

- `auth/pi-credential.ts`: the Pi-side OpenAI credential, read through Pi's published
  `readStoredCredential("openai-codex")` accessor and only otherwise by a read-only parse of
  `auth.json`. The refresh token is dropped at parse time — this extension never refreshes Pi's OAuth,
  and two writers to one credential is how tokens get invalidated mid-session. Command-backed API keys
  (`key: "!program"`) are refused rather than executed, and an explicit `authPath` reads exactly that
  file instead of quietly returning the default account.
- `auth/secret-text.ts`: `SecretText`, inert under `toString`, `JSON.stringify`, template interpolation,
  and inspection; the value is reachable only through `expose()`, alongside a non-reversible fingerprint.
- `auth/openai-identity.ts`: JWT claims → account id, masked email, plan hint, expiry. Codex tokens nest
  their claims under `https://api.openai.com/auth` / `…/profile` (a flattened spelling is also accepted);
  reading only flat dotted keys silently produced an empty identity against a real token.
- `auth/identity.ts` + `auth/adviser-auth.ts`: identity comparison (`match`/`mismatch`/`unknown`) and the
  auth state machine. An unconfirmed identity warns and proceeds; only a *demonstrated* mismatch blocks,
  because a prompt that fires every session trains the operator to click through it. An API key is
  transport, not an account, so it can never "match" a browser session. Pi token expiry is a warning —
  Pi refreshes transparently.
- `auth/login-flow.ts`: manual sign-in against an `AdviserLoginPort` that has **no** click, type,
  navigate, or solve method, so automating a login is impossible by construction. A human challenge is
  terminal (`retryMayHelp: false`); the profile is sealed before success is reported.
- `auth/status.ts`: one redacted status snapshot for the operator surface, with `assertStatusIsRedacted`
  rejecting credential-shaped keys and JWT-prefixed values. `auth/worker-independence.ts` states and
  checks that a local worker (Ollama/Qwen) is a normal case, not a special one.
- `browser/state-storage.ts`: state under the Pi agent directory with `0700`/`0600` modes re-asserted
  after `mkdir` (umask masking), create-exclusive + `O_NOFOLLOW` opens against planted symlinks, and an
  `OWNER` marker so ownership is proven rather than inferred from a directory name.
- `browser/chrome-state.ts` + `browser/cookie-import.ts`: Chromium-family detection (Linux/macOS) with
  "is Chromium holding this profile right now", and an allowlisted copy-only import. Nothing is ever
  decrypted — Chromium decrypts with the OS key at runtime, so the extension never holds or derives one
  (INV-12). A running source browser, a missing cookie database, a non-empty destination, and a
  self-import are all refused, not warned.
- `browser/capability.ts` + `browser/capability-checks.ts`: six probe outcomes kept distinct, the
  four-item pre-consultation checklist, model selection that never invents a model, and a cache that
  expires negative verdicts faster and treats a stated `retryAfterSeconds` as "re-probe", never as a
  cache lifetime.
- `protocol/adviser.ts`: one shared `AdviserNextAction` vocabulary used by capability, auth, and the UI,
  so a menu cannot offer an action nothing implements.
- `docs/AUTHENTICATION.md`: the two identities, discovery order, state paths and modes, the copy-not-
  decrypt import strategy, the no-decryption guarantee, platform claims (Windows returns no candidates
  rather than guessed paths), recovery table, and reset.
- 105 new tests in `auth/` and `browser/`, plus `test/adviser-strings-worker-safe.test.ts`, which runs
  every auth explanation, status line, and import refusal through the worker-safety pattern.

### Hardened after review (M2)

- `readPiOpenAiCredential` honours an explicit `authPath` by reading that file. The Pi accessor does not
  treat its second argument as a path, so passing an override through it returned the *default* account
  while reporting that it had read the named file — worst in tests and in the status surface, where a
  wrong-but-plausible answer is worse than an error. Test: "reads the named file when a path is given,
  even with a live Pi accessor".
- `capabilityCacheIsValid` never treats a stated retry window as cacheable: a remembered rate limit that
  has already lifted is a lie told by a stale record.
- The worker-safety check matches credential *material* (JWT/`ya29.` prefixes, `Bearer `, `token=`
  assignments, browser profile roots) rather than the English words "token"/"cookie", so prose like
  "the access token is expired" stays displayable and the check does not get switched off.
- `import-chrome-state` is now a human-gated action. Opening an adviser window already required a person,
  while copying the user's own cookie database did not — an inversion, since the copy is the more
  sensitive touch and is the one INV-11 is about. `protocol/adviser.test.ts` pins both halves of the split
  by enumeration, and `browser/capability.test.ts` asserts every probe record agrees with that policy.
- `SecretText` gains the serialisation routes that actually leak in practice — a nested object graph, a
  `Map`/`Set` member, deep `inspect`, `Error.stack`, an object spread, and a string-keyed poke at the
  `#private` field — plus an assertion that the instance stays frozen, so a debugging getter cannot attach
  the plaintext as an enumerable property.

### Hardened after review (M2, second pass)

A second invariant review of the same branch found the class of defect that unit tests cannot see: a
documented guard with no code behind it, and one safety rule encoded in two modules with opposite answers.
Both are fixed in code, and the docs now describe what the code does.

- Three state-tree defences that `docs/AUTHENTICATION.md`, `docs/SECURITY.md`, and the roadmap all claimed
  and none had: `writePrivateFileNoFollow` performs the create-exclusive + `O_NOFOLLOW` open (a planted
  symlink is refused as `symlink-refused`; `lstat` where `O_NOFOLLOW` is unavailable, and `chmod`
  re-applied because an `open` mode is umask-masked), `prepareStateStorage` reads the `OWNER` marker
  before it writes or chmods anything and refuses a pre-existing `browserRoot` that lacks it, and
  `modeGrantsAccessToOthers` is load-bearing — the mode on disk is re-read and refused, with
  `assertPrivateDirectory` for directories an import writes into but did not create. The guards are
  syscalls, so they are tested against a real filesystem; a fake can only encode the author's model of
  `open`, which is how all three survived the first review.
- `import-chrome-state` is gated at the effect, not only in the vocabulary.
  `applyChromeStateImport(plan, authorization, fileSystem)` refuses an import with no authorization
  (`not-authorized`) or one minted for another plan (`authorization-for-other-plan`), and
  `authorizeChromeStateImport` mints one only for the `HUMAN_IMPORT_CONFIRMATION` phrase, so
  `rg -n confirmedByHuman` is a complete audit of every call site. A phrase rather than a boolean is the
  gate against *accidental* plumbing; it is not a barrier to a deliberate cast, and it is documented as
  that rather than promised as more.
- `Local State` is scrubbed on the way in (`scrubChromeLocalState`, `LOCAL_STATE_SCRUB_PATHS`) rather than
  copied whole — whole carries `account_info` and `profile.info_cache` for every profile on the machine —
  keeping `os_crypt.encrypted_key` on Windows only. An unparseable `Local State` is refused
  (`source-unscrubbable`, a reason of its own rather than "not authorized"), and verification fails a copy
  that still carries account metadata (`unscrubbed-account-metadata`).
- One authoritative answer to "may this consultation proceed?". `resolveAccountIdentity`
  (`auth/identity.ts`) handles every case — including the unknown case `auth/adviser-auth.ts` used to
  early-return past, which made the strict copy dead code and left every run reporting `unknown → consult`
  — and `resolveAdviserAuth` delegates to it instead of holding its own rule.
- A mismatch choice is bound to the account pair it was made for (`AccountMismatchDecision.forAccountPair`,
  an opaque digest; `decideAccountMismatch`), so `keep-current` for one browser account has no effect when
  a different account appears later. The fact was renamed `mismatchChoice` → `mismatchDecision` because the
  old name is what a caller reaching for an unscoped flag would reach for.
- Identifiers declare a namespace (`AccountIdNamespace`). Chromium's `gaia_id` and Pi's
  `chatgpt_account_id` are different kinds of thing, and comparing them for equality produced a permanent
  "mismatch" against every real session; cross-namespace is now `unknown` with a stated reason, and
  `browser/chrome-state.ts` no longer fabricates a per-account id from a profile directory name.
- `detectBrowserStateSources` masks emails and GAIA ids while parsing (`protocol/masking.ts`, newly shared
  by `auth/` and `browser/` so the rule cannot drift), and `test/adviser-strings-worker-safe.test.ts`
  covers the listing.
- Path containment covers the whole source path: the profile directory name must be a single relative
  directory name, and the resolved path is asserted to stay inside the user-data-dir it was declared
  inside. A containment test that only checked the root passed while a `..` in the profile name walked the
  copy into the extension's own profile.
- `adviserStatus` asks Pi for the credential unless the caller names a file. It previously passed the
  default path unconditionally, so `via: "pi-api"` was unreachable and a user signed in through Pi's own
  store was told `missing-file` — "sign in" — while the adviser worked fine.
### Added — M3 (adviser browser runtime)

- `playwright-core` dependency. Exactly one module loads it — the composition root `browser/adviser-runtime.ts`,
  which drives the system Chrome channel via `launchPersistentContext` against the extension-owned profile.
  `playwright-driver.ts` receives the launcher as a parameter and imports the package structurally, so the
  lifecycle and DOM logic test with no browser installed; the barrel re-exports neither module, so loading
  the extension launches nothing. A test asserts the importer set is exactly that one module.
- `browser/runtime-types.ts` — the browser contract: a lifecycle phase union, consultation request/outcome/
  failure vocabulary, the narrow `AdviserPageDriver` seam, and the diagnostic policy expressed as data.
- `browser/runtime.ts` — `AdviserRuntime`, the lifecycle state machine: lazy start, reuse while healthy,
  relaunch when a "ready" browser has died, bounded launch retries with backoff, a serialised turn queue,
  one-launch-per-profile-under-concurrency, and a terminal human gate. It exposes no page/context/driver/
  selector/script accessor (INV-01/INV-09); a test asserts the absence.
- `browser/chatgpt-dom.ts` — the ChatGPT surface as pure decisions over a presence-only snapshot: surface
  classification, turn completion (requiring our own message before an answer counts), model-label matching,
  credential scrubbing, the selector sets with per-interaction fallbacks, and Cloudflare interstitial
  detection from the document title.
- `browser/playwright-driver.ts` — the real `AdviserPageDriver`: one reused tab, selector-set resolution that
  scans matched nodes for the first visible one, prompt typing, a bounded poll for the assistant turn, and
  cross-frame challenge probing. Playwright is imported structurally; the launcher is injected.
- `browser/adviser-runtime.ts` — the composition root that wires the runtime to the real launcher and
  implements M2's `AdviserLoginPort` on top of it (open/observe/seal only, so nothing can automate a login).
- `browser/diagnostics.ts` — post-login diagnostics: screenshots refused before login, DOM dumps with
  credential-shaped attribute values redacted, files at 0600 inside the git-ignored diagnostics dir, and
  retention bounded by both age and count.
- `browser/model-selection.ts` — `resolveModelPreference`, ranking a caller preference against live
  availability; a downgrade is always reported, an unclickable model is never returned, and the
  `auto-best`/no-match path selects the strongest selectable model with `degraded: true`.
- `StateStoragePaths.diagnosticsDir` for post-login artifacts, under the same permissioned root as the profile.
- Live validation probes under `_workspace/m3/` (`live-exit.ts`, `live-selectors.ts`) that drive the shipped
  composition root against the real ChatGPT surface.
- 75 new unit tests (584 total across 49 files).

### Hardened after live validation (M3)

Found by driving the shipped code against the real signed-out ChatGPT surface; the in-process fakes could
not see any of these:

- The runtime now opens the ChatGPT surface before classifying it. A freshly launched tab is `about:blank`,
  and classifying it reported "not the ChatGPT surface" about a page the runtime had not opened.
- The Cloudflare "Just a moment..."/"Attention Required" interstitial is detected from the document title
  and treated as a terminal human gate, not an "unknown" a caller might retry through.
- `firstVisible` scans the matched nodes for the first *visible* element instead of trusting element `[0]`;
  the live page carries many hidden duplicate controls whose first is invisible.
- The Playwright driver honours the caller's `headed` flag (a manual login must show a window); it had
  launched headless unconditionally, which would have opened an invisible window a human could not use.
- An explicitly-named missing `auth.json` is now reported as `missing-file`, not `unparsable`: with an
  explicit path the Pi accessor is never consulted, so its availability must not masquerade as the failure.
- **A human gate is terminal for `consult()` and never for observation.** The first implementation latched
  it and refused every subsequent call, which deadlocked manual login through the door it opened itself:
  opening the window navigates to ChatGPT, which reads `signed-out`, which latched the gate, which made the
  later `observeSession` that must notice a completed login refuse. A person would have sat signed in at a
  working window while the flow timed out. Reading a page asks nothing of a challenge, so observation stays
  available; asking the adviser a question while a challenge is up is what must never happen, so the refusal
  lives in `consult()` (INV-11 unchanged). Only the launch-retry circuit breaker refuses a call, because it
  is a proven transport failure. `runTurn` also stopped reporting a stale gate as the cause of a failed
  launch, which would have sent the operator to fix a login while Chrome was what was missing. The test for
  the previous behaviour *passed* — it asserted the deadlock — so it is replaced by tests pinning both
  halves, plus a port-level walk of open → still-signed-out → signed-in.

### Hardened after invariant review (M3)

The M3 gate (`pwc-invariant-review`) found no blockers and five majors. All five sat in the one module
nothing tested: `playwright-driver.ts` is glue, so its rules had been asserted only through the pure
classifiers that call it, never through the driver itself. That module now has `playwright-driver.test.ts`,
which drives the real driver against a scripted fake page — no Playwright import, and the fake thread
mutates *between polls*, which is the only way to express "the old answer was already on screen".

- **A turn could be credited to the answer that was already on screen.** Completion was
  `hasAssistantMessage && (!hadAssistantBefore || hasAssistantMessage)`, which reduces to
  `hasAssistantMessage`. On any conversation that already had a reply — a second turn, a restored thread —
  the consultation "completed" instantly on the previous answer and recorded its text against the new
  `consultationId`: confidently wrong advice carrying a correct provenance record (INV-05, INV-15).
  Completion is now a *change* in the visible assistant-message count, sampled before the send, through
  `assistantAnswerIsNew`. Named tests: `playwright-driver.test.ts`
  "reads the answer this turn produced, not the one already on screen" (fails on the old expression with
  `earlier advice`) and "never credits a previous answer to this consultation" (an honest miss is a
  timeout), plus `chatgpt-dom.test.ts` "refuses to credit an answer that was already on screen".
- **The answer was read from the oldest node in the thread.** `#readLatestAnswer` used `firstVisible`,
  whose first match in a conversation that keeps its history is the *earliest* answer — the same
  misattribution by a second route. `lastVisible` scans backwards from the newest end, bounded by
  `VISIBLE_SCAN_CAP`.
- **A page-controlled `<title>` reached a human-facing status line unscrubbed.** The
  `human-verification` explanation now runs it through `scrubPageText(…, 120)` like every other
  page-derived string, so a challenge page cannot put a token in a status line or make one long
  `<title>` into a paragraph (`chatgpt-dom.test.ts` "keeps a hostile page title out of the explanation").
- **Page-derived text chose what the driver clicks.** `selectModel` built
  `:has-text("<model-id fragment>")` by interpolation, and a model id is not always operator input:
  `runtime.consult()` passes the id `resolveModelPreference` landed on, and both its match and its fallback
  come from `listModels()`, whose ids are read off the model picker. A label containing `")` closed the
  string literal and addressed an element outside the model menu — verified against the fake, where the
  unsanitized driver clicks a node called "Log out of this device" (INV-05). `safeSelectorFragment` keeps
  model-name characters only and refuses an empty fragment instead of building `:has-text("")`, which
  matches every option and used to click the first one. Named tests: `playwright-driver.test.ts`
  "will not let a page-derived model id address an element outside the model menu" and "refuses to click
  whatever an empty model id happens to match".
- **`diagnostics/` was outside the permissioned tree.** `prepareStateStorage` created, re-permissioned,
  and re-read the mode of the state, browser, profile, and import directories, and omitted
  `paths.diagnosticsDir` — the one directory that accumulates page text and screenshots. `diagnostics.ts`
  does call `mkdir(..., 0o700)`, but that mode is masked by the umask and ignored for a directory that
  already exists, so a loose `diagnostics/` stayed loose while capturing page content, unseen by the
  "enforce, do not merely intend" mode check. It is now in both the created set and the owned set
  (`state-storage.test.ts` asserts the created list, the chmod set, and idempotency).
- `ConsultationOutcome.text` is documented where it is declared as untrusted adviser output that is
  deliberately *not* scrubbed or bounded — a truncated answer is a broken consultation — and it names
  `protocol/trust.ts` as the place that must brand it before a worker sees it (M6 owns that).

### Changed

- Toolchain fixed to TypeScript + Node 22 + npm + vitest (previously "to be fixed in M0");
  `README.md` development commands updated from the provisional `bun` examples.
- Roadmap M0, M1, M2, and M3 checkboxes ticked with a named artifact/test per item.
- INV-10, INV-11, INV-12 and INV-13 guards in `protocol/invariants.ts` now cite the M2 modules that
  enforce them (`auth/adviser-auth.ts`, `auth/login-flow.ts`, `browser/cookie-import.ts`,
  `auth/secret-text.ts`, `auth/status.ts`).
- INV-01 and INV-11 in `protocol/invariants.ts` additionally cite `browser/runtime.ts`, where the adviser's
  lack of execution power and the never-push-through-a-gate rule are enforced at runtime rather than only
  by type shape.
- INV-04 is no longer a deferred guard: `protocol/invariants.ts` points at
  `git/remote-availability.ts` + `git/checkpoint-resolution.ts`, leaving INV-14 (M6 prompt assembler)
  as the only planned guard. `docs/ARCHITECTURE.md` INV-04 is marked implemented.
- `protocol/checkpoint.ts` gains `"probe-inconclusive"`: a probe that completed without a decisive
  answer is neither a verdict about the commit nor a transport failure.

### Not yet implemented

No adviser consultation yet wired into a command. The browser runtime exists (M3): it launches the isolated
profile, opens ChatGPT, classifies the surface, selects a model, and can carry a prompt/response turn — but
nothing invokes it until the consultation protocol (M5–M7) and commands/UI (M8) land, and the extension
registers no commands or tools yet, by design. The runtime has been driven against the real ChatGPT surface
live (Chrome launches in the isolated profile; the signed-out page is correctly classified), but a full
consultation round trip needs a signed-in profile and closes with the M9 command flow. The checkpoint
subsystem exists but nothing calls it, and `GitHubApi.fetch` still defaults to `globalThis.fetch`, which M9
replaces with a key-redacting wrapper before any token can meet a redirected request.
