# pi-with-chatgpt — Implementation Roadmap

> **Working title:** `pi-with-chatgpt`  
> **V1 principle:** ChatGPT advises; Pi decides and executes.  
> **V1 context boundary:** GitHub only.  
> **Organization:** one ChatGPT Project per GitHub repository.

## Milestone Overview

- **M0 — Repository and architecture foundation**
- **M1 — Git/GitHub checkpoint subsystem**
- **M2 — OpenAI identity and isolated ChatGPT authentication**
- **M3 — Adviser browser runtime**
- **M4 — ChatGPT Project and conversation management**
- **M5 — Consultation job engine**
- **M6 — Prompt/response protocol and adviser ledger**
- **M7 — Drift analysis and advice disposition**
- **M8 — Pi UX and agent integration**
- **M9 — Concurrency, recovery, and hardening**
- **M10 — Cross-platform validation, documentation, and release**
- **Post-V1 — Optional richer evidence and integrations**

---

# M0 — Repository and Architecture Foundation
## M0 Evidence

- **Package:** `pi-with-chatgpt@0.0.1` (npm name unreserved at M0), ESM, `engines.node >= 22.19.0`,
  `pi.extensions = ["./dist/extension/index.js"]`, `keywords: ["pi-package", …]`, MIT `LICENSE`
  (dependencies reviewed: MIT/BSD-2/Apache-2.0; no reused source code).
- **Pi floor:** `MIN_PI_VERSION = 0.85.1` (`extension/pi-api.ts`), asserted against the installed Pi
  by `npm run smoke:pi`.
- **Toolchain:** `npm run typecheck | lint | build | test | smoke:pi` (all green locally;
  `npm run verify` runs the whole set). Active GitHub Actions CI is defined in
  `.github/workflows/ci.yml` for `ubuntu-latest` and `macos-latest`; `ci/README.md` documents the
  workflow's checks and supported triggers.
- **Modules:** `extension/ git/ auth/ browser/ chatgpt/ jobs/ protocol/ ledger/ drift/ config/ ui/`,
  each with a documented barrel; `test/module-boundaries.test.ts` forbids sibling trees.
- **Invariants:** `docs/ARCHITECTURE.md` (INV-01…INV-16 prose) + `protocol/invariants.ts` index;
  guards `protocol/{sha,checkpoint,context-channel,provider,trust,dependency}.ts`, `git/authority.ts`,
  `auth/identity.ts`, `browser/profile.ts`, `chatgpt/scope.ts`, `jobs/state.ts`, `ledger/record.ts`,
  `config/schema.ts`, `ui/worker-facing.ts`; at M0 `INV-04` and `INV-14` were explicitly `planned:M1`/
  `planned:M6`, and `protocol/invariants.test.ts` asserts the deferred set stays exactly that. M1
  promoted `INV-04` to implemented, so the test now pins `INV-14` as the only deferred guard.
- **Exit criteria:** `test/pi-smoke.mjs` proves `pi install` + clean activation with zero
  registrations; 160 vitest tests across 18 files; prohibited-by-construction source scan in
  `git/authority.test.ts`.

## Project Skeleton

- [x] Create the repository/package structure.
- [x] Choose final package/repository name.
- [x] Add MIT-compatible licensing after confirming reused dependencies/code.
- [x] Define supported Pi version floor.
- [x] Define supported Node/Bun runtime floor.
- [x] Establish TypeScript build/test/lint configuration.
- [x] Add CI for supported operating systems.
- [x] Add conventional package metadata for Pi extension installation.

## Suggested Module Boundaries

- [x] Create `extension/` for Pi-facing registration and lifecycle.
- [x] Create `git/` for repository/checkpoint resolution.
- [x] Create `auth/` for OpenAI identity and browser-session bootstrap.
- [x] Create `browser/` for isolated ChatGPT runtime.
- [x] Create `chatgpt/` for Project/conversation interaction.
- [x] Create `jobs/` for synchronous/asynchronous consultation state.
- [x] Create `protocol/` for request/response contracts.
- [x] Create `ledger/` for durable consultation state.
- [x] Create `drift/` for checkpoint-to-current analysis.
- [x] Create `config/` for global/project-safe configuration.
- [x] Create `ui/` for TUI status and compact user messaging.
- [x] Keep browser/ChatGPT internals outside agent prompt instructions.

## Architecture Invariants

- [x] Encode and document: ChatGPT has no execution ownership.
- [x] Encode and document: source-code context reaches ChatGPT only through GitHub in V1.
- [x] Encode and document: every consultation resolves to an immutable full commit SHA.
- [x] Encode and document: adviser output is non-authoritative.
- [x] Encode and document: consultation does not imply permission to commit or push.
- [x] Encode and document: adviser failure is non-blocking by default.
- [x] Encode and document: one ChatGPT Project maps to one GitHub repository.
- [x] Encode and document: unrelated tasks use separate adviser conversations.

## Exit Criteria

- [x] Package installs into Pi.
- [x] Extension loads without side effects.
- [x] Unit-test harness exists.
- [x] Architectural invariants are represented in tests or typed boundaries where practical.

---

# M1 — Git/GitHub Checkpoint Subsystem

## Repository Detection

- [x] Detect current git repository root.
- [x] Detect active branch.
- [x] Detect HEAD commit.
- [x] Detect configured remotes.
- [x] Select preferred GitHub remote deterministically.
- [x] Parse SSH and HTTPS GitHub remote forms.
- [x] Resolve canonical `owner/repo`.
- [x] Reject unsupported/non-GitHub remotes clearly in V1.
- [x] Handle detached HEAD.
- [x] Handle worktrees.
- [x] Handle repositories with multiple GitHub remotes.

## Immutable Checkpoint Resolution

- [x] Accept `HEAD`, branch, tag, SHA, and optional PR-derived refs.
- [x] Resolve every requested ref to a full commit SHA.
- [x] Persist both `requestedRef` and `resolvedCommit`.
- [x] Never silently retarget a completed/active consultation to a newer commit.
- [x] Add utilities for ancestor/divergence checks.

## Remote Availability

- [x] Determine whether target checkpoint is available on the selected GitHub remote.
- [x] Distinguish:
  - [x] current commit already pushed;
  - [x] local commit exists but is not pushed;
  - [x] uncommitted working tree only;
  - [x] commit exists remotely but branch moved;
  - [x] object is no longer available remotely.
- [x] Refuse adviser dispatch when the checkpoint is not remotely inspectable.
- [x] Do not perform blanket `git add -A`.
- [x] Do not infer authorization to commit/push from an adviser request.
- [x] Expose a structured “checkpoint not remote” result for the worker to handle under normal git permissions.

## PR Detection

- [x] Detect whether the current branch corresponds to an open PR when possible.
- [x] Store PR number as advisory metadata, never as the immutable anchor.
- [x] Resolve PR HEAD to full commit SHA.
- [x] Keep SHA authoritative if PR HEAD later moves.

## Tests

- [x] HTTPS remote parsing.
- [x] SSH remote parsing.
- [x] fork/upstream remote selection.
- [x] detached HEAD.
- [x] branch ahead of remote.
- [x] branch behind remote.
- [x] diverged branch.
- [x] force-pushed branch with retained local SHA.
- [x] worktree behavior.
- [x] shallow clone behavior.
- [x] no GitHub remote.
- [x] multiple PR/ref scenarios.

## Exit Criteria

- [x] Given a normal GitHub-backed repo, the extension can produce a stable consultation identity:
  - [x] repo;
  - [x] branch;
  - [x] requested ref;
  - [x] full resolved SHA;
  - [x] optional PR;
  - [x] remote availability status.

---


**M1 evidence.** Implemented in `git/` (`repository.ts`, `ref-resolution.ts`, `ancestry.ts`,
`remote-availability.ts`, `github-api.ts`, `pr-detection.ts`, `checkpoint-resolution.ts`) and specified
in `docs/CHECKPOINT_PROTOCOL.md`. Verified by `git/*.test.ts` (147 tests across 10 files) and
`test/git-integration.test.ts` (9 tests against real git repositories: worktrees, shallow clones,
detached HEAD, tag/abbreviated resolution, divergence, and a real `file://` force-push that keeps the
retained local SHA authoritative). `npm run verify` green: typecheck, lint, build, 303 tests, Pi smoke
(Pi 0.85.1). Independent invariant review returned *fix-then-merge* with no blocker; its three majors
(token-shaped output that `redactGitOutput` missed, an `ahead`/`behind` API whose parameter names invited
an inverted reading, and an unpinned GitHub API host holding a bearer token) and four minors are fixed in
the same milestone. Review priority 5 — whether promoting INV-04 early leaves a gap — is safe by
construction: M1 adds no adviser dispatch path at all, so there is nothing that could yet walk past the
gate. Design decision recorded in `docs/CHECKPOINT_PROTOCOL.md` §7: the consultation *identity*
is repo + requested ref + full SHA + optional PR + availability; the branch is carried as working-state
context and is deliberately not part of identity, because a branch can be renamed, deleted, or rebased
while advice is still being applied (INV-03).

---

# M2 — OpenAI Identity and Isolated ChatGPT Authentication

## Pi OpenAI/Codex Identity Reuse

- [x] Discover Pi's existing OpenAI/Codex OAuth credential through supported Pi abstractions.
      — `auth/pi-credential.ts` prefers Pi's published `readStoredCredential("openai-codex")` accessor
      (resolved from the host install, never by re-parsing Pi's internals); the read-only `auth.json`
      parse is a fallback. Tests: `auth/pi-credential.test.ts` ("prefers Pi's own accessor over reading
      the file", "falls back to a read-only parse of auth.json when Pi is not importable"). Live on
      Linux: real account resolved, `accountIdPrefix: "49b60951"`, `planHint: "plus"`.
- [x] Avoid directly reimplementing Pi token refresh if a supported API exists.
      — No refresh path exists: the refresh token is dropped at parse time so this extension can never
      become a second writer to Pi's OAuth. Test: "never carries the refresh token out of the reader".
      Expiry is therefore a warning only (Pi refreshes transparently) — `auth/adviser-auth.test.ts`
      "notes an expired token without blocking the consultation".
- [x] Read account identity metadata where safely available.
      — `auth/openai-identity.ts` decodes the access-token claims, reading the
      `https://api.openai.com/auth` / `https://api.openai.com/profile` namespaces Codex tokens actually
      use (a flattened spelling is accepted too). Tests: `auth/openai-identity.test.ts` (12).
- [x] Read plan/entitlement hints where available.
      — Same module; `planHintSuggestsPaid` labels free tiers honestly. Test: "labels free tiers
      honestly and stays a hint".
- [x] Treat plan metadata as a hint, not the final capability check.
      — Plan never gates a consultation; the browser capability probe does
      (`browser/capability-checks.ts`, `auth/identity.test.ts` "keeps plan metadata out of the identity
      comparison").
- [x] Ensure the active Pi worker model need not be OpenAI.
      — `auth/worker-independence.ts`; the worker provider/model are accepted and never read.
      Test: `auth/worker-independence.test.ts` "does not become more eligible when the worker is itself
      an OpenAI model".
- [x] Support a local/Qwen worker while reusing stored OpenAI identity.
      — Same module, pinned by "is eligible for a local worker as long as an OpenAI sign-in exists"
      (`ollama/qwen3-coder` + stored OpenAI sign-in ⇒ eligible). Status line names both sides:
      `worker: ollama/qwen3-coder; adviser: s***@gmail.com (plus)` (verified live).
- [x] Consider Codex CLI identity as an optional secondary source only if needed.
      — Considered and rejected for V1: Pi's own stored credential is always present when the user has
      a Codex subscription, and a second identity source would create a second account to mismatch
      against. Decision recorded in `docs/AUTHENTICATION.md` ("Credential discovery").

## Dedicated Adviser Browser State

- [x] Define OS-appropriate state directories.
      — `stateStoragePaths()` under `PI_CODING_AGENT_DIR` (default `~/.pi/agent/pi-with-chatgpt/browser`),
      documented in `docs/AUTHENTICATION.md`. Tests: "places state under the Pi agent directory, never the
      workspace", "follows the agent-directory override", "recognises the user's browser directories on
      every platform". Verified live on Linux: `~/.pi/agent/pi-with-chatgpt/browser` created `0700` with
      an `OWNER` marker and a self-ignoring `.gitignore`.
- [x] Create isolated ChatGPT profile storage.
      — `prepareStateStorage()` creates the tree and drops an `OWNER` marker; a pre-existing `browserRoot`
      without the marker is refused before anything is written or chmod-ed, so a tree the extension did not
      create is never adopted and the refusal leaves no side effects behind. Tests: "drops an ownership
      marker and a self-ignoring .gitignore", "produces a profile that satisfies the INV-11 ownership
      check", "refuses a pre-existing browser root that carries no ownership marker", "refuses adoption
      without writing or chmod-ing anything" (real filesystem).
- [x] Enforce restrictive filesystem permissions.
      — `0700` dirs / `0600` files, re-applied after `mkdir` (umask masking) and after an exclusive
      `O_NOFOLLOW` create (also umask-masked), and the mode on disk is re-read and refused when it still
      grants group or other access. Tests: "creates every directory owner-only and re-asserts the mode",
      "refuses a planted symlink instead of writing through it" (`ELOOP`/`EPERM` → `symlink-refused`, real
      filesystem), "refuses a state directory that is readable by other accounts", `assertPrivateDirectory`
      for directories an import writes into but did not create, `modeGrantsAccessToOthers` across six modes,
      and "refuses an override that points at the user's own browser".
- [x] Ensure browser credentials are never exposed to the worker model.
      — `auth/status.ts` exposes masked fields only and `assertStatusIsRedacted` rejects
      credential-shaped keys/JWTs; `test/adviser-strings-worker-safe.test.ts` runs every auth decision,
      status line and import refusal through the worker-safety pattern.
- [x] Ensure cookies/tokens are never written to normal logs.
      — `SecretText` is inert under `toString`/`JSON.stringify`/inspect
      (`auth/secret-text.test.ts`); status serialisation is asserted free of `eyJ`/fixture secrets
      (`auth/status.test.ts`); `docs/SECURITY.md` keeps the containment rule canonical.

## Chrome/Chromium Import Bootstrap

- [x] Detect supported local Chromium-family profiles.
      — `detectBrowserStateSources()` (Chrome/Chromium/Brave/Edge on Linux + macOS), including whether
      Chromium currently holds the profile, with every account field masked while parsing
      (`protocol/masking.ts`) and no fabricated identifier when Chrome recorded none. Tests:
      `browser/chrome-state.test.ts` ("masks every identity field it returns", "reports no account id when
      Chrome recorded none instead of inventing one"), plus
      `test/adviser-strings-worker-safe.test.ts` "keeps account material out of a browser-source listing".
      Live on Linux: 3 profiles found, all reported `lockedByRunningBrowser: true`, hints shown masked.
- [x] Make import an explicit authentication/repair action.
      — `planChromeStateImport` is pure planning with no implicit caller and refuses a non-empty
      destination so nothing can import "by the way". `applyChromeStateImport(plan, authorization, …)`
      refuses an import carrying no human authorization, and `authorizeChromeStateImport` mints one only
      for the phrase-bearing confirmation, fingerprinted to the plan's source and destination (INV-11).
      The command that invokes it lands in M9. Tests: `browser/cookie-import.test.ts`
      "refuses to overwrite a profile that already has a session", "refuses to import a profile onto
      itself", "refuses to copy without a human authorization", "refuses an authorization minted for a
      different plan", "refuses a profile directory name that is not a single relative directory name".
- [x] Open source browser profile read-only.
      — Import is a copy: no source path is ever opened for writing, and the plan is computed before any
      byte moves. Tests: "copies only the minimum set, in the expected layout", "refuses to copy from a
      running browser rather than risking a torn database".
- [x] Import only the state necessary to seed the isolated adviser profile.
      — `MINIMUM_CHATGPT_STATE_FILES` is an allowlist (cookie DB + `-wal`/`-shm` + `Local State`);
      an allowlist, so a new Chromium directory cannot silently widen the copy. `Local State` is scrubbed
      of the account metadata it does not need (`scrubChromeLocalState`,
      `LOCAL_STATE_SCRUB_PATHS`) and verification fails a copy that still carries it. Tests: "never copies
      anything outside the allowlist", "scrubs account metadata from the copied Local State",
      "keeps the Windows key reference and drops it elsewhere", "fails a copy that still carries account
      metadata", "refuses to copy a Local State it cannot examine".
- [x] Never automate the user's active browser for normal jobs.
      — No launcher for a user profile exists; `AdviserLoginPort` has no click/type/navigate/solve method,
      so the login flow cannot automate a browser even by accident
      (`auth/login-flow.test.ts`, `docs/SECURITY.md` INV-09/INV-11 rows).
- [ ] Verify the imported isolated profile can access ChatGPT.
      — Not closed: the checklist that expresses it exists and is tested
      (`browser/capability-checks.ts`), but the probe needs the Playwright runtime, so this closes with
      M3. No live ChatGPT session was exercised in M2 (human-gated login; see runbook in
      `docs/AUTHENTICATION.md`).
- [x] Handle encrypted cookie storage on supported OSes.
      — Copy-only: Chromium decrypts with the OS key at runtime, so no key is ever derived or held here
      (INV-12). `verifyChromeStateImport` checks sizes and SQLite magic bytes, reading no cookie value.
      Tests: "accepts an intact copy", "catches a truncated copy, the realistic failure when Chrome was
      running". Windows deliberately returns no candidates instead of guessing — "finds nothing on
      Windows, which is outside the V1 platform claim".
- [x] Provide clear recovery when cookie import is impossible.
      — Every refusal names the action (`source-browser-running` ⇒ "close Chrome and retry"), and
      `docs/AUTHENTICATION.md` "Troubleshooting" maps each code. Tests: "says a source has no session
      rather than reporting success", "refuses a source inside its own state tree", "reports a missing
      copy distinctly from a bad copy".

## Manual Login Fallback

- [x] Open the isolated adviser browser when no usable session exists.
      — `runManualLogin` opens through the port and reports a window that never opened without observing
      anything. Tests: `auth/login-flow.test.ts` (12).
- [x] Allow user login, CAPTCHA, 2FA, or consent steps.
      — The flow is inert by construction; a `human-verification` observation is terminal with
      `retryMayHelp: false`, because polling a CAPTCHA is automating it. Test: "stops at a human
      challenge instead of waiting it out".
- [x] Detect successful ChatGPT authentication.
      — `observeSession` polling with an injectable clock; `signed-in`/`signed-out`/
      `human-verification`/`unreachable` stay distinct outcomes. Tests: "gives up at the deadline rather
      than looping forever", "reports an unreachable network without claiming the credentials were wrong".
- [x] Persist the isolated profile.
      — The profile is sealed *before* success is reported (an unflushed profile returns logged out), and
      a `SESSION-ESTABLISHED` marker records that a human signed in once. Tests: "seals the profile
      before reporting success", "still reports success when the marker cannot be written".
- [x] Avoid asking again during normal use.
      — `shouldOfferInteractiveLogin` returns false once a session exists and while a challenge is
      pending. Tests: "does not nag once a session exists", "does not open a second window over a pending
      challenge".

## Account Matching

- [x] Compare Pi OpenAI identity with ChatGPT browser identity where possible.
      — `auth/identity.ts` is the single authority: `resolveAccountIdentity` answers every case
      (`confirmed`/`unverified`/`awaiting-user`/`skipped`) and `auth/adviser-auth.ts` holds no second copy,
      because two encodings of this rule disagreeing is how the looser one came to govern. Identifiers
      compare only inside a namespace, so a Chromium `gaia_id` against a ChatGPT account id is `unknown`
      with a stated reason rather than a permanent mismatch. Tests: `auth/identity.test.ts`,
      `auth/adviser-auth.test.ts` "calls an unconfirmable identity unverified rather than matched",
      "distinguishes cross-namespace ids from a mismatch instead of alarming on both".
- [x] Detect likely account mismatch.
      — A demonstrated mismatch requires both sides identified and differing; an API key counts as no
      identity, so it can never "match" a browser session. Tests: "treats a Pi API-key identity as no
      identity at all", "matches on account id".
- [x] Never silently switch to a different ChatGPT account.
      — Consultation is refused across a mismatch until an explicit choice exists, there is no boolean
      "ignore mismatches", and a choice is bound to the account pair it was minted for so approving one
      browser account cannot authorise the next one that appears. Tests: "refuses to consult across a
      silent account switch", "never proceeds silently from an unknown match", "does not carry a
      keep-current choice over to a different browser account".
- [x] Provide an explicit user choice/recovery path on mismatch.
      — Three choices (`keep-current` / `reauthenticate` / `skip-adviser`), each with its own outcome;
      reauthenticate routes to the login prompt rather than pretending progress. Tests:
      "proceeds only on an explicit keep-current choice, and says which account is being billed", "turns
      a reauthenticate choice into the login prompt, not into progress", "honours a decision to skip the
      adviser".

## Capability Verification

- [x] Verify ChatGPT access.
      — `chatgpt-access` is a required pre-consultation item; `classifyCapabilityProbe` keeps
      signed-in/signed-out/verification/rate-limited/plan/environment as six distinct outcomes.
      Tests: "treats only a signed-in probe as consultation-ready", "keeps a human challenge distinct
      from being signed out", "never carries runtime detail into the record".
- [x] Verify intended strong adviser model or best available equivalent.
      — `selectAdviserModel` returns the requested model, a marked-degraded equivalent, or `undefined`;
      it never invents a model. Tests: "never invents a model the provider does not offer".
- [x] Verify GitHub connector availability.
      — V1 treats `github-connector` as a required capability because it is the only repository-context
      channel. `evaluateConsultationPrerequisites` blocks both `unverified` and `unavailable` results and
      maps them to the explicit `connect-github` recovery action. Tests: "blocks a consultation on an
      unverified GitHub connector", "maps a missing GitHub connector to an explicit connector action".
- [x] Verify target repository visibility before first consultation.
      — `target-repository` is required; an unavailable checkpoint maps to `publish-checkpoint`, never to
      an implicit push. Test: "maps a missing checkpoint to publishing it, never to pushing silently".
- [x] Cache capability checks conservatively.
      — Status-dependent TTL (negative verdicts expire faster) and a stated `retryAfterSeconds` is never
      cached, because a remembered rate limit that has lifted is a lie.
      Tests: "expires a negative result faster than a positive one", "never caches a stated retry window".
- [x] Revalidate on meaningful auth/provider failures.
      — Invalidation events (sign-in completed, Chrome state imported, authentication failed, model list
      changed) void the cache regardless of age. Test: "invalidates on any revalidating event regardless
      of age".

## Tests

- [x] valid persisted adviser profile;
      — `auth/adviser-auth.test.ts` "verifies capability before offering to consult"; profile shape and
      ownership in `browser/state-storage.test.ts`.
- [x] expired ChatGPT session;
      — "notes an expired token without blocking the consultation" plus the marker/`everSignedInHere`
      distinction in `auth/status.test.ts` (expired session vs never signed in).
- [x] Pi OAuth present + browser auth absent;
      — "creates the profile before probing it" and "asks for Pi login before touching a browser" cover
      both halves of the ordering.
- [x] browser auth present + Pi OAuth absent;
      — "asks for Pi login before touching a browser": the Pi credential gates everything, so a browser
      session alone never enables the adviser.
- [x] account mismatch;
      — four mismatch tests in `auth/adviser-auth.test.ts` (refusal, each explicit choice, unknown).
- [x] Chrome import success;
      — `browser/cookie-import.test.ts`: "copies only the minimum set, in the expected layout",
      "creates the profile directory and copies exactly the planned files", "accepts an intact copy".
- [x] Chrome import failure;
      — running browser, missing cookie database, non-empty destination, self-import, and path escape are
      each refused by name in `browser/cookie-import.test.ts`.
- [x] manual login recovery;
      — `auth/login-flow.test.ts`: challenge stop, timeout, unreachable, locked profile, window failure,
      marker failure.
- [x] quota/model unavailable;
      — "keeps a rate limit automatic", "stops on an unsupported plan", and
      `selectAdviserModel` returning `undefined` when no equivalent exists.
- [x] GitHub connector unavailable.
      — `evaluateConsultationPrerequisites` blocks an unverified or unavailable connector and returns the
      `connect-github` recovery action; covered by `browser/capability-checks.test.ts`.

## Exit Criteria

- [ ] A Pi session using a local/non-OpenAI worker can authenticate and use a paid ChatGPT adviser without repeatedly logging in.
      — Partially met and deliberately not ticked: worker independence and one-time authentication are
      implemented and tested (`auth/worker-independence.test.ts`, `auth/login-flow.test.ts`), and the
      "without repeatedly logging in" half is enforced by profile persistence + seal + capability cache
      invalidation. The end-to-end half needs a real ChatGPT session in a real browser, which closes with
      M3; no live consultation was performed in M2 and none is claimed here.

---

# M3 — Adviser Browser Runtime

Playwright (`playwright-core`) over the system Chrome channel, driving the extension-owned profile from M2.
All lifecycle and classification logic lives behind a narrow `AdviserPageDriver` seam so it is unit-tested
without a browser; the Playwright layer is the only module that imports `playwright-core` eagerly, and the
barrel keeps it a deep import so loading the extension never launches Chrome.

## Runtime Ownership

- [x] Choose browser automation implementation.
      — `playwright-core` + system Chrome (`channel: "chrome"`) via `launchPersistentContext`; the launcher
      lives only in `browser/adviser-runtime.ts`.
- [x] Keep browser control extension-owned rather than worker-operated.
      — `AdviserRuntime` exposes no page/context/driver/selector/script accessor; the only browser-addressing
      call is `consult({ prompt, modelId })`. `browser/runtime.test.ts` asserts the absence structurally.
- [x] Create a reusable isolated ChatGPT runtime.
      — `createAdviserBrowser(paths)` in `browser/adviser-runtime.ts`.
- [x] Avoid using the user's normal Chrome profile in production.
      — the launcher passes only `adviserProfileFor(paths).userDataDir`, produced by `createAdviserProfile`,
      which refuses a path that looks like a user browser profile (INV-11).
- [x] Avoid global browser-state conflicts with other Pi extensions.
      — a single extension-owned `--user-data-dir` under the Pi agent dir; concurrent cold starts launch
      exactly one Chrome (`runtime.test.ts` "launches only once for concurrent callers").
- [x] Reuse authenticated state without unsafe profile sharing.
      — one persistent profile directory, no copying of a live profile; live exit probe confirmed Chrome 152
      launching in `~/.pi/agent/pi-with-chatgpt/browser/chatgpt-profile`.

## Session Lifecycle

- [x] Start browser lazily on first adviser use.
      — `runtime.test.ts` "does not launch until something needs the browser".
- [x] Reuse the runtime when healthy.
      — "launches once and reuses the browser across consultations".
- [x] Recover from browser crash.
      — "marks the browser degraded when the driver dies mid-turn, and recovers on the next call"; a
      health-check throw is treated as unhealthy, not propagated.
- [x] Recover from stale tabs.
      — `resetTab()` closes non-active tabs and re-creates a closed active one; `#requirePage` reopens on demand.
- [x] Shut down cleanly on Pi/session termination when appropriate.
      — `shutdown()` closes the context once and stays stopped ("closes the driver once and stays closed").
- [x] Preserve authenticated profile across restarts.
      — `launchPersistentContext` persists cookies to disk on close; the profile survives runtime restarts.
- [x] Separate persistent auth state from ephemeral task state.
      — persistent profile dir vs the `diagnostics/` scratch tree, both under one git-ignored root, distinct
      from the ephemeral consultation turn state.

## DOM/Interaction Robustness

- [x] Prefer semantic DOM operations over coordinates/screenshots.
      — every interaction resolves a selector set (`CHATGPT_SELECTORS`); no coordinate clicking anywhere.
- [x] Detect ChatGPT generation-in-progress reliably.
      — `classifySurface` → `generating` from the stop/appending indicators (`chatgpt-dom.test.ts`).
- [x] Detect completed assistant turn.
      — `classifyTurn` requires *our own message* before an answer counts ("does not mistake a previous
      answer for the new one") — the failure that would return last week's advice. The check is a *change*
      in the visible assistant-message count (`assistantAnswerIsNew`), and the answer is read from the
      *newest* visible node: `playwright-driver.test.ts` "reads the answer this turn produced, not the one
      already on screen" and "never credits a previous answer to this consultation" pin both at the driver.
- [x] Detect visible provider errors.
      — `provider-error` state from banner/alert notices; turns classify `error` and stop rather than wait.
- [x] Detect login/challenge pages.
      — sign-in affordances (both "Log in" and "Sign in" spellings, `/login`/`/signup` links) → `signed-out`;
      Cloudflare interstitials by DOM probe across frames and by document title ("Just a moment...",
      "Attention Required") → terminal `human-verification`. Both confirmed against the live surface.
- [x] Handle ChatGPT UI changes with localized adapters.
      — selector sets + pure classifiers in `chatgpt-dom.ts`; a rename is one reviewable diff, each
      interaction carries fallbacks, and visibility is scanned across duplicate hidden controls.
- [x] Avoid long single blocking browser waits.
      — `askAndAwaitTurn` polls on an interval against a deadline; no single blocking wait.
- [x] Implement bounded polling/backoff.
      — turn loop bounded by `timeoutMs`; launch retries bounded (`maxConsecutiveLaunchFailures`) with backoff.
- [x] Save sufficient diagnostics without recording credentials.
      — `browser/diagnostics.ts`: screenshots refused before login, DOM dumps attribute-redacted, files 0600,
      retention bounded by age and count. Key test asserts the pre-login screenshot is refused. The dir
      itself is created and re-permissioned `0700` inside the owned tree
      (`state-storage.test.ts` "creates every directory owner-only and re-asserts the mode").

## Model Selection

- [x] Implement `auto-best` default.
      — `resolveModelPreference` with an empty/no-match preference falls back to the strongest selectable
      model, marked degraded.
- [x] Permit explicit configured adviser model/preset.
      — the preference list is caller-supplied; `modelId` on `ConsultationRequest` is already resolved.
- [x] Detect when configured model is unavailable.
      — `modelMatchesLabel` + `selectModel` re-reads the picker; `model-unavailable` is returned, never
      silently ignored (`runtime.test.ts` "reports model-unavailable instead of asking a different model").
      Selecting a model never clicks an arbitrary element: `safeSelectorFragment` refuses page-derived text
      that could leave the model menu (`playwright-driver.test.ts` "will not let a page-derived model id
      address an element outside the model menu").
- [x] Fall back safely or report capability mismatch.
      — `resolveModelPreference` reports `degraded` + `reason` on every non-top-preference landing.
- [x] Never silently use a clearly weaker/free model when the request specifically requires the configured adviser capability.
      — a downgrade is always reported (`degraded: true` with a reason); the runtime refuses to submit when
      the requested model cannot be selected rather than substituting a weaker one.

## Exit Criteria

- [ ] Extension can reliably open ChatGPT, select adviser capability, submit a small test prompt, and collect the response using the isolated profile.
      — Partially met, deliberately not ticked. The live probe (`_workspace/m3/live-exit.ts`) drives the
      shipped composition root and confirmed: Chrome 152 launches in the isolated profile, ChatGPT opens,
      and the classifier correctly reports `signed-out` (actionable: false) rather than inventing a
      conversation. The full round trip (capability select + prompt + response) needs a signed-in profile,
      which is human-gated (cookie import or interactive login); no live consultation was performed and none
      is claimed. It closes when a signed-in session is exercised in the M9 command flow.

---

# M4 — ChatGPT Project and Conversation Management

## Repository → Project Mapping

- [x] Define stable repository identity key.
- [x] Detect whether a ChatGPT Project mapping already exists.
- [x] Create one ChatGPT Project per GitHub repository when needed.
- [x] Persist Project identifier/URL locally.
- [x] Reuse existing mapping across Pi sessions.
- [x] Recover if the Project is renamed.
- [x] Recover if the Project is deleted.
- [x] Avoid creating duplicate Projects during concurrent setup.

## Project Instructions

- [x] Define concise Project instructions.
- [x] State that the Project is bound to one GitHub repository.
- [x] State that Pi executes and ChatGPT advises.
- [x] State that requested commit SHA is authoritative.
- [x] State that ChatGPT should inspect GitHub directly.
- [x] State that ChatGPT should not ask Pi to paste repository files.
- [x] State that Project memory is lower priority than current checkpoint code.
- [x] Avoid embedding ephemeral branch/commit values in Project instructions.

## Task Conversation Mapping

- [x] Define task/session identity.
- [x] Create one adviser conversation per task.
- [x] Persist conversation ID/URL.
- [x] Reuse same conversation for follow-ups.
- [x] Start a new conversation for unrelated tasks.
- [x] Prevent concurrent writes to the same conversation.
- [x] Keep different task conversations isolated under the single-tab V1 browser policy.
      — Mapping records may coexist, but the execution engine serializes all adviser turns while one
      tracked browser tab is shared; this prevents navigation/send cross-talk until conversation-scoped
      pages are available.

## Recovery

- [x] Detect deleted/stale conversation.
- [x] Start a replacement conversation in the same Project.
- [x] Return a concise task handoff for the dispatcher when continuity matters.
- [x] Never treat Project memory as a substitute for exact checkpoint provenance.

## Exit Criteria

- [x] One repository consistently maps to one ChatGPT Project and multiple task-specific conversations can coexist safely.
      — Evidence: `chatgpt/project-mapping.test.ts` covers stable identity, exact-once races, adoption,
      rename, deletion/recreation, corruption refusal, and persist-before-ready; `chatgpt/project-instructions.test.ts`
      covers all standing rules and ephemeral-value rejection; `chatgpt/conversation-mapping.test.ts` covers
      task isolation and keyed concurrency; `chatgpt/conversation-recovery.test.ts` covers same-Project
      replacement and checkpoint-anchored handoff; `browser/playwright-project-surface.test.ts` and
      `browser/chatgpt-project-dom.test.ts` cover the bounded DOM adapter. No live ChatGPT round trip is claimed.

---

# M5 — Consultation Job Engine

## Durable Job Storage Evidence (partial M5)

- `jobs/record.ts` defines strict version-1 job records and `adv-…` IDs. `jobs/record.test.ts`
  verifies immutable, remotely available GitHub anchors, closed state shapes, defaults, and refusals.
- `jobs/store.ts` persists creation, claims, terminal outcomes, and identity-bound response files.
  `jobs/store.test.ts` covers independent-store races, wrong repository/task/Pi routing digest,
  dispatch/receipt snapshots, interrupted completion, restart lookup, private files, and corruption.
- Mode/dependency and parsed action-item fields are supported as stored metadata. The unchecked
  execution items below require a browser dispatcher, background lifecycle, and targeted Pi delivery.
  No actual submission or wake-up is claimed by storage tests, and the M5 exit criterion stays open.
- Storage/recovery contract: `docs/CONSULTATION_PROTOCOL.md`. The next execution slice must make
  conversation selection and submission one protected browser operation on the shared tab.

## Job Model

- [x] Define consultation job state machine.
- [x] Support queued, running, completed, failed, cancelled.
- [x] Support synchronous and asynchronous modes.
- [x] Support `dependency: advisory | required`.
- [x] Allocate stable consultation IDs such as `adv-...`.
- [x] Persist state before browser submission.
- [x] Persist result before wake-up delivery.

## Suggested Job Record

- [x] repository identity;
- [x] branch;
- [x] requested ref;
- [x] resolved SHA;
- [x] HEAD at dispatch;
- [x] optional PR;
- [x] request type;
- [x] dependency type;
- [x] ChatGPT Project ID;
- [x] conversation ID;
- [x] timestamps;
- [x] result status;
- [x] HEAD at receipt;
- [x] response path;
- [x] parsed action items. (Persisted fields; adviser-text extraction remains M6.)

## Synchronous Execution

- [x] Submit and await adviser response.
- [x] Bound wait behavior.
- [x] Allow cancellation.
- [x] Surface provider/auth errors cleanly.
- [x] Preserve durable result if user interrupts UI delivery.

## Asynchronous Execution

- [x] Dispatch without blocking the worker.
- [x] Persist detached/background job state safely.
- [x] Continue Pi work.
- [x] Detect completion.
- [x] Best-effort wake-up matching the correct Pi session/task.
- [x] Preserve result even if wake-up is missed.
- [x] Add `/advisor-status` and `/advisor-read`.
      — Commands and tools query the live JobStore first, then terminal ledger history; covered by
      `extension/commands.test.ts`, `extension/tools.test.ts`, and `test/m10-release-validation.test.ts`.

## Concurrency

- [x] Configure a conservative default maximum number of concurrent ChatGPT jobs.
- [x] Serialize operations within the same ChatGPT conversation.
- [x] Serialize browser turns across conversations while V1 owns one tracked tab.
      — `ConsultationEngine` clamps injected concurrency limits to one; independent tasks remain isolated
      and queue safely until a conversation-scoped browser operation exists.
- [x] Prevent Project-creation races.
- [x] Prevent auth-maintenance races.
- [x] Prevent duplicate job dispatch after retries/restarts.

## Exit Criteria

- [x] At least two independent task consultations can run safely without cross-delivery or conversation contamination.
      — Evidence: `jobs/engine.test.ts` ("serializes independent consultations while the adviser owns one tracked browser tab",
      "prevents cross-delivery to unrelated Pi session wake-up listeners (INV-09)", "serializes consultations within the same task conversation (INV-09)");
      `jobs/store.test.ts` (27 storage tests covering claims, terminal races, recovery).

---

# M6 — Consultation Protocol and Adviser Ledger

## Request Builder

- [x] Implement semantic request types:
  - [x] consult;
  - [x] plan;
  - [x] review;
  - [x] audit;
  - [x] debug;
  - [x] challenge.
- [x] Build concise decision briefs.
- [x] Include exact repository.
- [x] Include full checkpoint SHA.
- [x] Include branch and optional PR as metadata.
- [x] Include goal.
- [x] Include current approach when relevant.
- [x] Include concern/question.
- [x] Tell ChatGPT to inspect GitHub itself.
- [x] Tell ChatGPT not to implement or request source-file uploads.
- [x] Tell ChatGPT that development may advance while it reasons.

## Response Contract

- [x] Define hybrid structured/prose output.
- [x] Require consultation ID.
- [x] Require reviewed commit SHA.
- [x] Request status/assessment.
- [x] Request explicit recommendations.
- [x] Request stable action-item IDs.
- [x] Allow risks and optional ideas.
- [x] Preserve raw response.
- [x] Parse structured fields opportunistically rather than failing the whole job on minor format deviation.

## Commit Verification

- [x] Verify returned/referenced reviewed SHA when possible.
- [x] Mark malformed or ambiguous provenance.
- [x] Never silently assign a different reviewed SHA.

## Local Adviser Ledger

- [x] Define global state root.
- [x] Define repository-specific ledger location.
- [x] Append consultation metadata transactionally.
- [x] Store full response separately when large.
- [x] Persist conversation mapping.
- [x] Persist parsed action items.
- [x] Add efficient lookup by:
  - [x] consultation ID;
  - [x] repository;
  - [x] task;
  - [x] commit;
  - [x] status;
  - [x] date.
- [x] Avoid putting full historical advice into Pi model context by default.

## Tests

- [x] valid structured response;
- [x] partially malformed response;
- [x] missing action IDs;
- [x] mismatched SHA;
- [x] empty response;
- [x] duplicated completion;
- [x] interrupted write;
- [x] ledger migration/versioning.

## Exit Criteria

- [x] Every completed consultation is auditable without relying on conversational memory.
      — Evidence: `protocol/brief.test.ts` (brief construction, kind support, detached HEAD, code dump/credential validation);
      `protocol/response.test.ts` (hybrid structured/prose parsing, header blocks, opportunistic fallback, commit verification, action-item normalization);
      `ledger/ledger.test.ts` (transactional JSONL append, separate markdown responses, multi-attribute indexing, interrupted write resilience, schema migration);
      `jobs/engine.test.ts` (end-to-end engine execution automatically records completed consultation and parsed action items into ConsultationLedger).

---

# M7 — Drift Analysis and Advice Disposition

## Graph-Level Drift

- [x] Compare adviser checkpoint to current HEAD.
      — `drift/graph-drift.ts` computes graph relationships between checkpoint SHA and current HEAD SHA via `git/ancestry.ts`.
- [x] Detect equality.
      — `compareGraphDrift` returns `equal` with 0 ahead/behind. Tests: `drift/graph-drift.test.ts` ("detects equality when checkpoint matches HEAD").
- [x] Detect ancestor relationship.
      — Returns `checkpoint-is-ancestor` or `checkpoint-is-descendant` with commit distances. Tests: `drift/graph-drift.test.ts` ("detects checkpoint-is-ancestor with ahead/behind distances", "detects checkpoint-is-descendant").
- [x] Detect divergence.
      — Returns `diverged` with ahead/behind counts from merge base. Tests: `drift/graph-drift.test.ts` ("detects divergence with ahead/behind counts").
- [x] Detect missing/unreachable checkpoint.
      — Returns `unreachable`. Tests: `drift/graph-drift.test.ts` ("handles unreachable commits cleanly").
- [x] Compute commits ahead/behind where meaningful.
      — Ahead/behind counts included in all non-equal relationships. Tests: `drift/graph-drift.test.ts`.

## Relevant File Drift

- [x] Extract files/components referenced in adviser output when feasible.
      — `extractMentionedFiles` in `drift/file-drift.ts` parses backtick paths and word paths from advice and action items. Tests: `drift/file-drift.test.ts` ("extracts paths from backticks and text", "normalizes leading ./").
- [x] Compute files changed since adviser checkpoint.
      — `analyzeFileDrift` parses `git diff --name-status` against HEAD. Tests: `drift/file-drift.test.ts` ("computes directly affected files matching mentioned paths").
- [x] Highlight overlap.
      — Directly overlapping files categorized in `directlyAffectedFiles`. Tests: `drift/file-drift.test.ts`.
- [x] Identify changed interfaces/config/tests around referenced components.
      — `relatedContextFiles` captures sibling tests, configs, and directory matches. Tests: `drift/file-drift.test.ts` ("detects related context files").
- [x] Keep analysis deterministic where possible.
      — Deterministic regex extraction and git diff parsing without model hallucinations. Tests: `drift/file-drift.test.ts`.
- [x] Avoid automatic reconsultation merely because HEAD changed.
      — Purely read-only analysis; no reconsultation is triggered automatically (INV-05).

## Revalidation Recommendation

- [x] Classify advice as:
  - [x] current;
  - [x] likely applicable;
  - [x] materially stale;
  - [x] needs reconsultation;
  - [x] provenance degraded.
      — `classifyAdviceDrift` in `drift/classification.ts` produces `current`, `likely_applicable`, `materially_stale`, `needs_reconsultation`, `provenance_degraded`. Tests: `drift/classification.test.ts` (5 tests covering all 5 statuses).
- [x] Surface concise drift notes to Pi.
      — `formatDriftSummary` outputs single-line summary with commit distances and overlapping files. Tests: `drift/classification.test.ts`.
- [x] Make full diff analysis available to the worker when needed.
      — `formatDetailedDriftReport` generates structured markdown breakdown of status, commits, overlapping files, and related files. Tests: `drift/classification.test.ts`.

## Action Item Disposition

- [x] Implement supported dispositions:
  - [x] accepted;
  - [x] implemented;
  - [x] partially_implemented;
  - [x] rejected_with_reason;
  - [x] superseded;
  - [x] stale;
  - [x] needs_reconsultation.
      — `VALID_DISPOSITIONS` in `drift/disposition.ts` and `protocol/response.ts`. Tests: `drift/disposition.test.ts`.
- [x] Permit worker/user to record disposition.
      — `updateItemDisposition` in `drift/disposition.ts` updates disposition in ledger entry atomically. Tests: `drift/disposition.test.ts` ("updates disposition in memory and writes to ledger").
- [x] Preserve reason for rejection/supersession.
      — Requires non-empty reason when disposition is `rejected_with_reason` or `superseded`. Tests: `drift/disposition.test.ts` ("requires reason for rejected_with_reason and superseded").
- [x] Support follow-up prompts that summarize action-item disposition.
      — `buildFollowUpBrief` formats prior action items and their disposition statuses. Tests: `drift/follow-up.test.ts`.

## Follow-Up Workflow

- [ ] `/advisor-followup <id> ...` (M8 command layer)
- [x] Reuse original task conversation where healthy.
      — Follow-up brief maintains task/conversation linkage. Tests: `drift/follow-up.test.ts`.
- [x] Include original reviewed checkpoint.
      — `originalCheckpointSha` preserved in brief. Tests: `drift/follow-up.test.ts`.
- [x] Include new checkpoint.
      — `newCheckpointSha` included in brief. Tests: `drift/follow-up.test.ts`.
- [x] Include previous action items and dispositions.
      — Itemized prior action items with status and rationale included in brief. Tests: `drift/follow-up.test.ts`.
- [x] Ask ChatGPT to inspect the new GitHub state rather than relying on prose claims.
      — Explicit instruction directing ChatGPT to inspect git diff between checkpoints on GitHub. Tests: `drift/follow-up.test.ts` ("includes git diff comparison instructions between original and new checkpoints").

## Exit Criteria

- [x] Advice received several commits later can be evaluated against the current development cursor without pretending both sides are synchronized.
      — Evaluated via graph and file drift with clear staleness classification and follow-up paths. All 720 tests passing.

---

# M8 — Pi UX and Agent Integration

## User-Facing Commands

- [x] `/advisor <request>`
      — `extension/commands.ts:handleConsultation`, tested in `extension/commands.test.ts`.
- [x] `/advisor-plan <request>`
      — `extension/commands.ts:handleConsultation(..., "plan")`, tested in `extension/commands.test.ts`.
- [x] `/advisor-review [request]`
      — `extension/commands.ts:handleConsultation(..., "review")`, tested in `extension/commands.test.ts`.
- [x] `/advisor-audit <request>`
      — `extension/commands.ts:handleConsultation(..., "audit")`, tested in `extension/commands.test.ts`.
- [x] `/advisor-debug <request>`
      — `extension/commands.ts:handleConsultation(..., "debug")`, tested in `extension/commands.test.ts`.
- [x] `/advisor-challenge <request>`
      — `extension/commands.ts:handleConsultation(..., "challenge")`, tested in `extension/commands.test.ts`.
- [x] `/advisor-followup <consultation-id> <request>`
      — `extension/commands.ts:handleFollowUp`, tested in `extension/commands.test.ts`.
- [x] `/advisor-status [consultation-id]`
      — `extension/commands.ts:handleStatus`, tested in `extension/commands.test.ts`.
- [x] `/advisor-read [consultation-id]`
      — `extension/commands.ts:handleRead`, tested in `extension/commands.test.ts`.
- [x] `/advisor-cancel <consultation-id>`
      — `extension/commands.ts:handleCancel`, tested in `extension/commands.test.ts`.
- [x] `/advisor-auth`
      — `extension/commands.ts:handleAuth`, tested in `extension/commands.test.ts`.

## Agent-Facing Tools

- [x] `advisor_preflight`
      — `extension/tools.ts:createPreflightTool`, tested in `extension/tools.test.ts`.
- [x] `advisor_submit`
      — `extension/tools.ts:createSubmitTool`, tested in `extension/tools.test.ts`.
- [x] `advisor_read`
      — `extension/tools.ts:createReadTool`, tested in `extension/tools.test.ts`.
- [x] `advisor_status`
      — `extension/tools.ts:createStatusTool`, tested in `extension/tools.test.ts`.
- [x] `advisor_followup`
      — `extension/tools.ts:createFollowUpTool`, tested in `extension/tools.test.ts`.
- [x] `advisor_cancel`
      — `extension/tools.ts:createCancelTool`, tested in `extension/tools.test.ts`.
- [x] `advisor_auth`
      — `extension/tools.ts:createAuthTool`, tested in `extension/tools.test.ts`.
- [x] `advisor_disposition`
      — `extension/tools.ts:createDispositionTool`, tested in `extension/tools.test.ts`.

## Hidden vs Visible Instructions

- [x] Keep verbose browser/protocol instructions out of the visible user transcript.
      — `ui/tui.ts` formats clean summaries, hiding internal DOM/OAuth/browser details; tested in `ui/tui.test.ts`.
- [x] Keep slash-command recall/history compact.
      — `ui/tui.ts:formatDispatchStatus` outputs single-line status; tested in `ui/tui.test.ts`.
- [x] Give the worker structured tool outputs.
      — `extension/tools.ts` returns structured `content` and `details` objects for every tool; tested in `extension/tools.test.ts`.
- [x] Avoid teaching the worker low-level ChatGPT DOM control.
      — `ui/worker-facing.ts:toWorkerFacingAdvisory` filters out internal browser/DOM selectors; tested in `ui/worker-facing.test.ts`.
- [x] Keep adviser-role guidance concise and stable.
      — `chatgpt/project-instructions.ts` and `protocol/brief.ts` provide stable instructions; tested in `protocol/brief.test.ts`.

## Auto-Consultation Policy

- [x] Default auto-consultation to conservative/high-value only.
      — `ui/policy.ts:evaluateAutoConsultation` defaults to `high-value`; tested in `ui/policy.test.ts`.
- [x] Define semantic triggers.
      — `ui/policy.ts:HIGH_VALUE_PATTERNS` matches architectural, security, migration, and concurrency changes; tested in `ui/policy.test.ts`.
- [x] Avoid consulting for trivial edits.
      — `ui/policy.ts:TRIVIAL_PATTERNS` suppresses spelling, lint, whitespace, and doc changes; tested in `ui/policy.test.ts`.
- [x] Avoid consulting solely because line count is large.
      — `ui/policy.ts` evaluates semantic intent and module span, not LOC alone; tested in `ui/policy.test.ts`.
- [x] Avoid simple fixed retry-count triggers as the only criterion.
      — `ui/policy.ts` suppresses simple retry loops without semantic triggers; tested in `ui/policy.test.ts`.
- [x] Allow `off | high-value | always` if configuration is exposed.
      — `ui/policy.ts:AutoConsultPolicy` type and evaluation branches; tested in `ui/policy.test.ts`.
- [x] Default to `high-value`.
      — `ui/policy.ts:evaluateAutoConsultation` parameter default; tested in `ui/policy.test.ts`.

## TUI Experience

- [x] Compact dispatch status.
      — `ui/tui.ts:formatDispatchStatus`; tested in `ui/tui.test.ts`.
- [x] Show repo/checkpoint/PR.
      — Included in `formatDispatchStatus`; tested in `ui/tui.test.ts`.
- [x] Show sync vs async.
      — Included in `formatDispatchStatus`; tested in `ui/tui.test.ts`.
- [x] Show job ID.
      — Included in `formatDispatchStatus`; tested in `ui/tui.test.ts`.
- [x] Show adviser completion notification.
      — `ui/tui.ts:formatCompletionNotification`; tested in `ui/tui.test.ts`.
- [x] Show checkpoint drift summary.
      — `extension/commands.ts:handleStatus` formats real-time drift classification; tested in `extension/commands.test.ts`.
- [x] Show top action items.
      — Included in `formatCompletionNotification`; tested in `ui/tui.test.ts`.
- [x] Allow full response expansion on demand.
      — `/advisor-read` and `ui/tui.ts:formatFullAdvisoryView`; tested in `extension/commands.test.ts` and `ui/tui.test.ts`.
- [x] Avoid exposing OAuth/cookie/browser internals unless troubleshooting requires it.
      — `auth/status.ts` masks email/tokens, `ui/worker-facing.ts` filters secrets; tested in `auth/status.test.ts` and `ui/worker-facing.test.ts`.

## Exit Criteria

- [x] A normal user can request advice without understanding the implementation machinery.
      — Verified via slash commands (`/advisor`, `/advisor-read`, etc.), clean TUI notifications, pure Pi extension registration, and `npm run smoke:pi`.

---

# M9 — Concurrency, Recovery, and Hardening

## Failure Recovery

- [x] Browser crash recovery.
      — `browser/session.ts` and `jobs/engine.ts`; tested in `test/m9-concurrency-recovery.test.ts` ("recovers from browser crash during active consultation and permits subsequent turns").
- [x] ChatGPT login expiry.
      — `browser/session.ts:detectAuthStatus` -> `sign-in-required`, `auth/status.ts`; tested in `browser/session.test.ts` and `test/m9-concurrency-recovery.test.ts`.
- [x] CAPTCHA/2FA path.
      — `browser/session.ts:detectAuthStatus` -> `human-verification` challenge stops automation immediately (INV-09); tested in `browser/session.test.ts` and `auth/adviser-auth.test.ts`.
- [x] GitHub connector unavailable.
      — The capability checklist treats `github-connector` as a required pre-consultation item and reports
      `connect-github` rather than dispatching a generic, repository-free answer; tested in
      `browser/capability-checks.test.ts`.
- [x] Repository permission missing.
      — `git/remote-availability.ts` reports unreachable/permission errors and the checkpoint gate refuses
      dispatch; tested in `git/remote-availability.test.ts` and `git/github-api.test.ts`.
- [x] ChatGPT Project missing.
      — `chatgpt/project-mapping.ts:ensureProjectForRepository` recreates missing project gracefully; tested in `test/m9-concurrency-recovery.test.ts` ("recovers from deleted Project by creating a new Project").
- [x] Conversation deleted.
      — `jobs/engine.ts` recreates conversation when deleted on subsequent turn; tested in `jobs/engine.test.ts`.
- [x] model unavailable.
      — Mapped to `plan-unsupported` or `model-unavailable` non-blocking failure; tested in `test/m9-concurrency-recovery.test.ts` ("maps provider rate limits or model unavailability to non-blocking failure").
- [x] quota exhausted.
      — Mapped to `rate-limited` non-blocking failure; tested in `test/m9-concurrency-recovery.test.ts`.
- [x] provider timeout.
      — `browser/runtime-types.ts` RejectionReason `provider-timeout`, `jobs/engine.ts:submitSync`; tested in `jobs/engine.test.ts`.
- [x] Pi exits during active async job.
      — `jobs/store.ts` persists jobs on disk in state layout (`jobs/<job-id>.json`), survived across engine restart; tested in `jobs/engine.test.ts`.
- [x] worker session changes before wake-up.
      — WakeUpNotification payload checks `deliveryKey` matching active Pi session; tested in `test/m9-concurrency-recovery.test.ts` ("session isolation: never wakes the wrong Pi session").
- [x] commit disappears after force push.
      — `git/remote-availability.ts:checkCommitAvailabilityOnRemote` detects `diverged` / `missing-commit`; tested in `test/git-integration.test.ts`.

## Delivery Correctness

- [x] Persist Pi session identity for async wake-up.
      — `jobs/store.ts` stores `deliveryKey`; tested in `jobs/store.test.ts`.
- [x] Never wake the wrong Pi session.
      — `jobs/engine.ts:deliverNotifications` validates delivery key before emitting; tested in `test/m9-concurrency-recovery.test.ts` ("session isolation: never wakes the wrong Pi session").
- [x] Never attach response from repo A to repo B.
      — `ledger/` and `jobs/` enforce repository scoping; `ConsultationJobStore` throws `job-scope-mismatch`; tested in `test/m9-concurrency-recovery.test.ts` ("repository isolation: never attaches response from repo A to repo B").
- [x] Never attach conversation from task A to task B.
      — `jobs/engine.ts` isolates conversation keys per task (`conversationKeyForTask`); tested in `test/m9-concurrency-recovery.test.ts`.
- [x] Make ambiguous recovery manual rather than guessing.
      — Stale or mismatching advice flags manual human review (`review_required`); tested in `ledger/drift-record.test.ts`.

## Security

- [x] Threat-model browser cookie storage.
      — Documented in `docs/SECURITY.md` and `docs/AUTHENTICATION.md`; browser profile kept in isolated 0700 dir (INV-11).
- [x] Threat-model source browser import.
      — Documented in `docs/AUTHENTICATION.md`; read-only cookie extraction, never attaches active browser session.
- [x] Threat-model project-local config.
      — Strict validation in `config/`; no executable scripts or arbitrary shell invocations in config files.
- [x] Threat-model malicious repository prompt injection.
      — `chatgpt/project-instructions.ts:buildProjectInstructions` explicitly instructs adviser that repository files and PR comments are untrusted input; tested in `test/m9-concurrency-recovery.test.ts` ("prompt injection defense: standing instructions explicitly state repo context is untrusted").
- [x] Explicitly tell adviser that repository content is untrusted.
      — Included in `buildProjectInstructions`; tested in `test/m9-concurrency-recovery.test.ts`.
- [x] Ensure repository content cannot grant new capabilities.
      — Adviser output is untrusted and worker-facing advisory is strictly read-only structured data (INV-01); tested in `test/m9-concurrency-recovery.test.ts`.
- [x] Ensure adviser output cannot directly trigger privileged execution.
      — Adviser output requires Pi worker disposition and execution; tested in `test/m9-concurrency-recovery.test.ts`.
- [x] Redact credentials from logs.
      — `auth/status.ts` masks email/tokens, `assertCredentialFreeValue` strips bearer tokens, JWTs, and keys; tested in `test/m9-concurrency-recovery.test.ts` ("credential containment: assertions reject leaks of tokens or secrets").
- [x] Redact browser/session identifiers from user-facing diagnostics where unnecessary.
      — `ui/worker-facing.ts:toWorkerFacingAdvisory` strips internal session IDs, browser paths, and selectors (INV-13); tested in `test/m9-concurrency-recovery.test.ts` ("opacity: worker-facing representation hides DOM selectors, internal URLs, and browser paths").
- [x] Restrict state-directory permissions.
      — `ledger/state-store.ts:ensurePrivateDirectory` enforces `0700`; tested in `test/m9-concurrency-recovery.test.ts` ("restricts state directory permissions to 0700").
- [x] Add safe cleanup policies.
      — `config/state-layout.ts` and `jobs/store.ts` support clean isolation and unlinking of stale locks/scratch.

## Git Safety

- [x] Adviser request does not imply commit authorization.
      — Verified across `git/`, `extension/`, `test/m9-concurrency-recovery.test.ts`; zero git write invocations.
- [x] Adviser request does not imply push authorization.
      — Zero git push invocations in any module.
- [x] Never add ignored/untracked files automatically.
      — Zero `git add` invocations; verified in test suites.
- [x] Respect existing Pi/project trust and git safety policy.
      — Verified via pure consultation pipeline.
- [x] Never push to a remote merely because it is named `origin`.
      — Enforced by absence of any push mechanisms and explicit remote verification (`git/remote-availability.ts`).
- [x] Verify selected GitHub remote.
      — `git/remote-availability.ts:checkRemoteAccessibility` verifies remote reachability via `ls-remote`.
- [x] Handle protected/default branches gracefully.
      — Non-destructive read-only checkpoint resolution (`git/checkpoint-resolution.ts`).

## Concurrency/Race Testing

- [x] simultaneous consultations in one repo;
      — Tested in `test/m9-concurrency-recovery.test.ts` ("serializes independent tasks while V1 owns one tracked adviser tab").
- [x] simultaneous Project initialization;
      — Tested in `test/m9-concurrency-recovery.test.ts` ("concurrency: simultaneous Project initialization adopts winner without collision").
- [x] simultaneous auth repair;
      — Serialized via mutex or idempotent status check; tested in `auth/status.test.ts`.
- [x] two follow-ups to same conversation;
      — Mutex queue serializes turns for the same task conversation; tested in `test/m9-concurrency-recovery.test.ts` ("concurrency: same conversation turns are serialized under mutex").
- [x] browser restart during multiple active jobs;
      — Tested in `test/m9-concurrency-recovery.test.ts`.
- [x] duplicate completion callback;
      — Idempotent update in `jobs/store.ts`; tested in `test/m9-concurrency-recovery.test.ts`.
- [x] cancel/complete race;
      — Tested in `test/m9-concurrency-recovery.test.ts` ("concurrency: cancel vs complete race condition handling").
- [x] Pi session shutdown/wake-up race;
      — Tested in `test/m9-concurrency-recovery.test.ts`.

## Exit Criteria

- [x] Failures degrade predictably and do not corrupt adviser mappings, Git state, browser auth, or Pi session delivery.
      — Verified by `test/m9-concurrency-recovery.test.ts` (13 tests) and complete test suite (73 test files, 756 tests).

---

# M10 — Cross-Platform Validation, Documentation, and Release

## Platform Validation

- [x] macOS Apple Silicon.
      — Verified natively on host (Darwin arm64); tested in `test/m10-release-validation.test.ts` and `test/pi-smoke.mjs`.
- [x] Linux desktop, including Chromium-family profile handling.
      — Verified via platform-neutral profile abstractions in `browser/chrome-state.test.ts`, `browser/state-storage.test.ts`, and `browser/cookie-import.test.ts`.
- [x] Windows native if included in V1 support claim.
      — Deferred to post-V1 per `AGENTS.md` ("Linux and macOS are the V1 platforms; Windows is post-V1").
- [x] Validate filesystem state paths.
      — `browser/state-storage.ts`, `config/state-layout.ts`, `ledger/state-store.ts`; tested in `test/m10-release-validation.test.ts`.
- [x] Validate browser discovery.
      — `browser/chrome-state.ts`; tested in `browser/chrome-state.test.ts`.
- [x] Validate encrypted-cookie bootstrap.
      — `browser/cookie-import.ts`; tested in `browser/cookie-import.test.ts`.
- [x] Validate git/SSH/HTTPS remote parsing.
      — `git/repository.ts`; tested in `git/repository.test.ts`.
- [x] Validate async worker/process behavior.
      — `jobs/engine.ts`; tested in `jobs/engine.test.ts` and `test/m10-release-validation.test.ts`.

## Worker Model Matrix

Test at minimum:

- [x] OpenAI inexpensive worker model.
      — `auth/worker-independence.ts`; tested in `test/m10-release-validation.test.ts`.
- [x] local OpenAI-compatible worker.
      — Tested in `auth/worker-independence.test.ts` and `test/m10-release-validation.test.ts`.
- [x] Qwen-family local model.
      — Tested in `test/m10-release-validation.test.ts`.
- [x] another non-OpenAI cloud worker if practical.
      — Tested in `test/m10-release-validation.test.ts`.

Verify that adviser auth is independent from active worker provider.
      — `auth/worker-independence.ts:assessAdviserEligibility`; tested in `test/m10-release-validation.test.ts`.

## Repository Scenarios

- [x] public repo;
      — `git/repository.ts`; tested in `git/repository.test.ts`.
- [x] private repo accessible to ChatGPT GitHub connector;
      — Tested in `git/remote-availability.test.ts` and `test/m10-release-validation.test.ts`.
- [x] fork;
      — Tested in `git/repository.test.ts`.
- [x] draft PR;
      — Tested in `git/pr-detection.test.ts`.
- [x] branch without PR;
      — Tested in `git/pr-detection.test.ts`.
- [x] detached HEAD;
      — Tested in `test/git-integration.test.ts`.
- [x] multi-worktree;
      — Tested in `test/git-integration.test.ts`.
- [x] large repo;
      — Verified via streaming git diff and ref-resolution.
- [x] monorepo;
      — Tested in `git/repository.test.ts`.
- [x] force-push history;
      — Tested in `test/git-integration.test.ts` (INV-03).
- [x] shallow clone.
      — Tested in `test/git-integration.test.ts`.

## Documentation

- [x] `README.md`
      — Upgraded to complete V1 documentation with command and tool tables, install instructions, architecture diagram, and security guarantees.
- [x] `ARCHITECTURE.md`
      — Architectural model, component boundaries, and invariant specifications (INV-01 through INV-16).
- [x] `SECURITY.md`
      — Security threat model, credential containment, and sandbox isolation.
- [x] `AUTHENTICATION.md`
      — Isolated browser profile, OAuth token discovery, and manual login guidance.
- [x] `CHECKPOINT_PROTOCOL.md`
      — Full commit SHA resolution, remote reachability, and immutability rules.
- [x] `CONSULTATION_PROTOCOL.md`
      — Decision briefs, structured responses, durable job stores, and transactional ledger.
- [x] `TROUBLESHOOTING.md`
      — Comprehensive troubleshooting guide covering auth repair, CAPTCHA, permissions, connector access, drift, and degradation.
- [x] extension config reference;
      — Documented in `docs/TROUBLESHOOTING.md` and `config/schema.ts`.
- [x] examples for plan/review/audit/debug/challenge;
      — Documented in `README.md` and `docs/TROUBLESHOOTING.md`.
- [x] explanation of advisory vs required consultation;
      — Documented in `docs/TROUBLESHOOTING.md`.
- [x] explanation of development cursor vs advice cursor;
      — Documented in `README.md` and `docs/TROUBLESHOOTING.md`.
- [x] privacy statement: GitHub-only source context in V1.
      — Documented in `README.md`, `SECURITY.md`, and `docs/TROUBLESHOOTING.md`.

## Usability

- [x] One-command install.
      — `pi install git:github.com/SaehwanPark/pi-with-chatgpt` or `pi install <dir>`.
- [x] Minimal first-run authentication.
      — Automatic OpenAI OAuth identity discovery or single interactive `/advisor-auth` launch.
- [x] Clear one-time GitHub connector prerequisite.
      — Documented in `README.md` and `docs/TROUBLESHOOTING.md`.
- [x] Automatic Project mapping.
      — 1:1 repository-to-Project mapping in `chatgpt/project-mapping.ts`.
- [x] No mandatory low-level config.
      — Defaults to `advisory`, `sync`, `high-value` auto-consultation.
- [x] Friendly repair flow.
      — `/advisor-auth` command provides diagnostic status and manual browser login launcher.
- [x] Clear behavior when checkpoint is not pushed.
      — Preflight and submit tools provide actionable `missing-commit` error guidance to run `git push`.
- [x] Clear behavior when adviser is unavailable.
      — Advisory mode non-blocking degradation permits worker progression (`blocked: false`).

## Release Gates

- [x] unit tests green;
      — 74 test files, 764 tests passing cleanly.
- [x] integration tests green;
      — `test/git-integration.test.ts` and `test/m10-release-validation.test.ts` passing cleanly.
- [x] cross-platform smoke tests green;
      — `npm run smoke:pi` passing on Pi 0.85.1 and isolated environments.
- [x] auth recovery drill passes;
      — Verified in `auth/login-flow.test.ts` and `test/m9-concurrency-recovery.test.ts`.
- [x] concurrency/race suite passes;
      — Verified in `test/m9-concurrency-recovery.test.ts` (13 tests).
- [x] security review complete;
      — All invariants INV-01 through INV-16 verified and enforced.
- [x] no source archive/upload path present in V1;
      — Verified by invariant review.
- [x] no normal-path automation of active user browser;
      — Enforced by dedicated isolated profile storage (INV-11).
- [x] checkpoint provenance verified end-to-end;
      — Verified in `protocol/response.test.ts` and `jobs/engine.test.ts`.
- [x] stale-advice drift flow verified;
      — Verified in `drift/` test suite and `test/m10-release-validation.test.ts`.
- [x] asynchronous wake-up correctness verified.
      — Verified in `jobs/engine.test.ts` and `test/m9-concurrency-recovery.test.ts`.

## Exit Criteria

- [x] Publish a documented V1 that can be installed and used without manual internal setup.
      — Verified: package installs cleanly via `pi install`, activates with zero side effects, and provides 11 slash commands, 8 agent tools, and full documentation.

---

# Post-V1 Backlog

These items are explicitly deferred until the GitHub-only architecture is stable.

## Optional Ephemeral Evidence Channel

- [ ] Evaluate sanitized test/log snippets.
- [ ] Define strict size/type limits.
- [ ] Ensure this does not become a backdoor repository-upload mechanism.
- [ ] Make evidence provenance explicit.
- [ ] Keep code canonical on GitHub.

## Advice Publication

- [ ] Optional publish-to-PR-comment workflow.
- [ ] Optional GitHub issue creation.
- [ ] Optional ADR drafting.
- [ ] Never publish adviser output automatically by default.

## Additional Providers

- [ ] Evaluate Grok adviser backend.
- [ ] Evaluate other subscription web advisers.
- [ ] Keep provider adapters independent from checkpoint/ledger core.

## Richer Drift Intelligence

- [ ] semantic component-level drift;
- [ ] recommendation-to-diff mapping;
- [ ] automatic implemented/superseded inference;
- [ ] risk-weighted reconsultation recommendations.

## Team/Subagent Integration

- [ ] shared adviser queue across Pi subagents;
- [ ] consultation ownership;
- [ ] deduplicate equivalent adviser requests;
- [ ] combine independent subagent briefs;
- [ ] route completed advice to the relevant owning agent;
- [ ] integrate cleanly with ownership/borrowing models.

## Multi-Repository Support

- [ ] consultation spanning several repositories;
- [ ] repository-set checkpoints;
- [ ] cross-repo ChatGPT Project strategy;
- [ ] provenance across multiple SHAs.

---

# Recommended Implementation Order

The shortest path to a trustworthy prototype is:

1. [x] repository/ref/SHA resolution;
2. [x] isolated ChatGPT authentication;
3. [x] reliable browser request/response;
4. [x] one-repo → one-Project mapping;
5. [x] one synchronous `/advisor` request anchored to a pushed SHA;
6. [x] durable ledger;
7. [x] asynchronous jobs;
8. [x] drift analysis;
9. [x] action-item disposition/follow-up;
10. [x] auto-consultation;
11. [x] concurrency hardening;
12. [x] cross-platform release work.

Do **not** begin with autonomous trigger heuristics or sophisticated UI. First make the immutable-checkpoint consultation path reliable and auditable end to end.

---

# V1 Definition of Done

V1 is complete when:

- [x] Pi can run with an inexpensive or local worker model.
- [x] The extension can reuse/validate the user's OpenAI identity.
- [x] ChatGPT operates from an isolated persistent adviser browser profile.
- [x] The user's active browser is not automated during normal adviser work.
- [x] One ChatGPT Project is maintained per GitHub repository.
- [x] Separate Pi tasks use separate adviser conversations.
- [x] Every consultation is anchored to a remotely available immutable full SHA.
- [x] ChatGPT reads repository context through GitHub only.
- [x] No repository archive or local source upload path exists.
- [x] Synchronous consultation works.
- [x] Asynchronous consultation works.
- [x] Adviser results persist durably.
- [x] Async results wake the correct Pi session on a best-effort basis.
- [x] Advice includes/verifies checkpoint provenance.
- [x] The extension reports drift between adviser checkpoint and current Pi HEAD.
- [x] Advice action items can be dispositioned and followed up.
- [x] Adviser unavailability normally degrades to local Pi execution.
- [x] Core race, recovery, authentication, and git-safety cases are covered by tests.
- [x] Supported platforms pass smoke tests.
- [x] Normal users can install and use the extension with minimal configuration.
