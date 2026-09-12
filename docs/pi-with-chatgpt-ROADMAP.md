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
  `npm run verify` runs the whole set). CI is defined in `ci/ci.yml` for `ubuntu-latest` and
  `macos-latest`; it is staged outside `.github/workflows/` only because the available GitHub
  credential lacks the `workflow` scope (see `ci/README.md` for the one-command maintainer fix).
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
      — `github-connector` is checked but deliberately non-blocking: its absence degrades the adviser's
      visibility, not the run. Test: "does not block a consultation on an unverified GitHub connector".
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
      — "does not block a consultation on an unverified GitHub connector"; the connector state is reported
      without disabling the consultation.

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
- [x] Permit concurrent consultations in different task conversations.

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
- [ ] Add `/advisor-status` and `/advisor-read`. (Commands registered in M8; engine backing exists.)

## Concurrency

- [x] Configure a conservative default maximum number of concurrent ChatGPT jobs.
- [x] Serialize operations within the same ChatGPT conversation.
- [x] Permit parallel conversations when safe.
- [x] Prevent Project-creation races.
- [x] Prevent auth-maintenance races.
- [x] Prevent duplicate job dispatch after retries/restarts.

## Exit Criteria

- [x] At least two independent task consultations can run safely without cross-delivery or conversation contamination.
      — Evidence: `jobs/engine.test.ts` ("allows parallel consultations across independent task conversations (M5 exit criterion)",
      "prevents cross-delivery to unrelated Pi session wake-up listeners (INV-09)", "serializes consultations within the same task conversation (INV-09)");
      `jobs/store.test.ts` (27 storage tests covering claims, terminal races, recovery).

---

# M6 — Consultation Protocol and Adviser Ledger

## Request Builder

- [ ] Implement semantic request types:
  - [ ] consult;
  - [ ] plan;
  - [ ] review;
  - [ ] audit;
  - [ ] debug;
  - [ ] challenge.
- [ ] Build concise decision briefs.
- [ ] Include exact repository.
- [ ] Include full checkpoint SHA.
- [ ] Include branch and optional PR as metadata.
- [ ] Include goal.
- [ ] Include current approach when relevant.
- [ ] Include concern/question.
- [ ] Tell ChatGPT to inspect GitHub itself.
- [ ] Tell ChatGPT not to implement or request source-file uploads.
- [ ] Tell ChatGPT that development may advance while it reasons.

## Response Contract

- [ ] Define hybrid structured/prose output.
- [ ] Require consultation ID.
- [ ] Require reviewed commit SHA.
- [ ] Request status/assessment.
- [ ] Request explicit recommendations.
- [ ] Request stable action-item IDs.
- [ ] Allow risks and optional ideas.
- [ ] Preserve raw response.
- [ ] Parse structured fields opportunistically rather than failing the whole job on minor format deviation.

## Commit Verification

- [ ] Verify returned/referenced reviewed SHA when possible.
- [ ] Mark malformed or ambiguous provenance.
- [ ] Never silently assign a different reviewed SHA.

## Local Adviser Ledger

- [ ] Define global state root.
- [ ] Define repository-specific ledger location.
- [ ] Append consultation metadata transactionally.
- [ ] Store full response separately when large.
- [ ] Persist conversation mapping.
- [ ] Persist parsed action items.
- [ ] Add efficient lookup by:
  - [ ] consultation ID;
  - [ ] repository;
  - [ ] task;
  - [ ] commit;
  - [ ] status;
  - [ ] date.
- [ ] Avoid putting full historical advice into Pi model context by default.

## Tests

- [ ] valid structured response;
- [ ] partially malformed response;
- [ ] missing action IDs;
- [ ] mismatched SHA;
- [ ] empty response;
- [ ] duplicated completion;
- [ ] interrupted write;
- [ ] ledger migration/versioning.

## Exit Criteria

- [ ] Every completed consultation is auditable without relying on conversational memory.

---

# M7 — Drift Analysis and Advice Disposition

## Graph-Level Drift

- [ ] Compare adviser checkpoint to current HEAD.
- [ ] Detect equality.
- [ ] Detect ancestor relationship.
- [ ] Detect divergence.
- [ ] Detect missing/unreachable checkpoint.
- [ ] Compute commits ahead/behind where meaningful.

## Relevant File Drift

- [ ] Extract files/components referenced in adviser output when feasible.
- [ ] Compute files changed since adviser checkpoint.
- [ ] Highlight overlap.
- [ ] Identify changed interfaces/config/tests around referenced components.
- [ ] Keep analysis deterministic where possible.
- [ ] Avoid automatic reconsultation merely because HEAD changed.

## Revalidation Recommendation

- [ ] Classify advice as:
  - [ ] current;
  - [ ] likely applicable;
  - [ ] materially stale;
  - [ ] needs reconsultation;
  - [ ] provenance degraded.
- [ ] Surface concise drift notes to Pi.
- [ ] Make full diff analysis available to the worker when needed.

## Action Item Disposition

- [ ] Implement supported dispositions:
  - [ ] accepted;
  - [ ] implemented;
  - [ ] partially_implemented;
  - [ ] rejected_with_reason;
  - [ ] superseded;
  - [ ] stale;
  - [ ] needs_reconsultation.
- [ ] Permit worker/user to record disposition.
- [ ] Preserve reason for rejection/supersession.
- [ ] Support follow-up prompts that summarize action-item disposition.

## Follow-Up Workflow

- [ ] `/advisor-followup <id> ...`
- [ ] Reuse original task conversation where healthy.
- [ ] Include original reviewed checkpoint.
- [ ] Include new checkpoint.
- [ ] Include previous action items and dispositions.
- [ ] Ask ChatGPT to inspect the new GitHub state rather than relying on prose claims.

## Exit Criteria

- [ ] Advice received several commits later can be evaluated against the current development cursor without pretending both sides are synchronized.

---

# M8 — Pi UX and Agent Integration

## User-Facing Commands

- [ ] `/advisor <request>`
- [ ] `/advisor-plan <request>`
- [ ] `/advisor-review [request]`
- [ ] `/advisor-audit <request>`
- [ ] `/advisor-debug <request>`
- [ ] `/advisor-challenge <request>`
- [ ] `/advisor-followup <consultation-id> <request>`
- [ ] `/advisor-status [consultation-id]`
- [ ] `/advisor-read [consultation-id]`
- [ ] `/advisor-cancel <consultation-id>`
- [ ] `/advisor-auth`

## Agent-Facing Tools

- [ ] `advisor_preflight`
- [ ] `advisor_submit`
- [ ] `advisor_read`
- [ ] `advisor_status`
- [ ] `advisor_followup`
- [ ] `advisor_cancel`
- [ ] `advisor_auth`
- [ ] `advisor_disposition`

## Hidden vs Visible Instructions

- [ ] Keep verbose browser/protocol instructions out of the visible user transcript.
- [ ] Keep slash-command recall/history compact.
- [ ] Give the worker structured tool outputs.
- [ ] Avoid teaching the worker low-level ChatGPT DOM control.
- [ ] Keep adviser-role guidance concise and stable.

## Auto-Consultation Policy

- [ ] Default auto-consultation to conservative/high-value only.
- [ ] Define semantic triggers.
- [ ] Avoid consulting for trivial edits.
- [ ] Avoid consulting solely because line count is large.
- [ ] Avoid simple fixed retry-count triggers as the only criterion.
- [ ] Allow `off | high-value | always` if configuration is exposed.
- [ ] Default to `high-value`.

## TUI Experience

- [ ] Compact dispatch status.
- [ ] Show repo/checkpoint/PR.
- [ ] Show sync vs async.
- [ ] Show job ID.
- [ ] Show adviser completion notification.
- [ ] Show checkpoint drift summary.
- [ ] Show top action items.
- [ ] Allow full response expansion on demand.
- [ ] Avoid exposing OAuth/cookie/browser internals unless troubleshooting requires it.

## Exit Criteria

- [ ] A normal user can request advice without understanding the implementation machinery.

---

# M9 — Concurrency, Recovery, and Hardening

## Failure Recovery

- [ ] Browser crash recovery.
- [ ] ChatGPT login expiry.
- [ ] CAPTCHA/2FA path.
- [ ] GitHub connector unavailable.
- [ ] Repository permission missing.
- [ ] ChatGPT Project missing.
- [ ] Conversation deleted.
- [ ] model unavailable.
- [ ] quota exhausted.
- [ ] provider timeout.
- [ ] Pi exits during active async job.
- [ ] worker session changes before wake-up.
- [ ] commit disappears after force push.

## Delivery Correctness

- [ ] Persist Pi session identity for async wake-up.
- [ ] Never wake the wrong Pi session.
- [ ] Never attach response from repo A to repo B.
- [ ] Never attach conversation from task A to task B.
- [ ] Make ambiguous recovery manual rather than guessing.

## Security

- [ ] Threat-model browser cookie storage.
- [ ] Threat-model source browser import.
- [ ] Threat-model project-local config.
- [ ] Threat-model malicious repository prompt injection.
- [ ] Explicitly tell adviser that repository content is untrusted.
- [ ] Ensure repository content cannot grant new capabilities.
- [ ] Ensure adviser output cannot directly trigger privileged execution.
- [ ] Redact credentials from logs.
- [ ] Redact browser/session identifiers from user-facing diagnostics where unnecessary.
- [ ] Restrict state-directory permissions.
- [ ] Add safe cleanup policies.

## Git Safety

- [ ] Adviser request does not imply commit authorization.
- [ ] Adviser request does not imply push authorization.
- [ ] Never add ignored/untracked files automatically.
- [ ] Respect existing Pi/project trust and git safety policy.
- [ ] Never push to a remote merely because it is named `origin`.
- [ ] Verify selected GitHub remote.
- [ ] Handle protected/default branches gracefully.

## Concurrency/Race Testing

- [ ] simultaneous consultations in one repo;
- [ ] simultaneous Project initialization;
- [ ] simultaneous auth repair;
- [ ] two follow-ups to same conversation;
- [ ] browser restart during multiple active jobs;
- [ ] duplicate completion callback;
- [ ] cancel/complete race;
- [ ] Pi session shutdown/wake-up race.

## Exit Criteria

- [ ] Failures degrade predictably and do not corrupt adviser mappings, Git state, browser auth, or Pi session delivery.

---

# M10 — Cross-Platform Validation, Documentation, and Release

## Platform Validation

- [ ] macOS Apple Silicon.
- [ ] Linux desktop, including Chromium-family profile handling.
- [ ] Windows native if included in V1 support claim.
- [ ] Validate filesystem state paths.
- [ ] Validate browser discovery.
- [ ] Validate encrypted-cookie bootstrap.
- [ ] Validate git/SSH/HTTPS remote parsing.
- [ ] Validate async worker/process behavior.

## Worker Model Matrix

Test at minimum:

- [ ] OpenAI inexpensive worker model.
- [ ] local OpenAI-compatible worker.
- [ ] Qwen-family local model.
- [ ] another non-OpenAI cloud worker if practical.

Verify that adviser auth is independent from active worker provider.

## Repository Scenarios

- [ ] public repo;
- [ ] private repo accessible to ChatGPT GitHub connector;
- [ ] fork;
- [ ] draft PR;
- [ ] branch without PR;
- [ ] detached HEAD;
- [ ] multi-worktree;
- [ ] large repo;
- [ ] monorepo;
- [ ] force-push history;
- [ ] shallow clone.

## Documentation

- [ ] `README.md`
- [ ] `ARCHITECTURE.md`
- [ ] `SECURITY.md`
- [ ] `AUTHENTICATION.md`
- [ ] `CHECKPOINT_PROTOCOL.md`
- [ ] `CONSULTATION_PROTOCOL.md`
- [ ] `TROUBLESHOOTING.md`
- [ ] extension config reference;
- [ ] examples for plan/review/audit/debug/challenge;
- [ ] explanation of advisory vs required consultation;
- [ ] explanation of development cursor vs advice cursor;
- [ ] privacy statement: GitHub-only source context in V1.

## Usability

- [ ] One-command install.
- [ ] Minimal first-run authentication.
- [ ] Clear one-time GitHub connector prerequisite.
- [ ] Automatic Project mapping.
- [ ] No mandatory low-level config.
- [ ] Friendly repair flow.
- [ ] Clear behavior when checkpoint is not pushed.
- [ ] Clear behavior when adviser is unavailable.

## Release Gates

- [ ] unit tests green;
- [ ] integration tests green;
- [ ] cross-platform smoke tests green;
- [ ] auth recovery drill passes;
- [ ] concurrency/race suite passes;
- [ ] security review complete;
- [ ] no source archive/upload path present in V1;
- [ ] no normal-path automation of active user browser;
- [ ] checkpoint provenance verified end-to-end;
- [ ] stale-advice drift flow verified;
- [ ] asynchronous wake-up correctness verified.

## Exit Criteria

- [ ] Publish a documented V1 that can be installed and used without manual internal setup.

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

1. [ ] repository/ref/SHA resolution;
2. [ ] isolated ChatGPT authentication;
3. [ ] reliable browser request/response;
4. [ ] one-repo → one-Project mapping;
5. [ ] one synchronous `/advisor` request anchored to a pushed SHA;
6. [ ] durable ledger;
7. [ ] asynchronous jobs;
8. [ ] drift analysis;
9. [ ] action-item disposition/follow-up;
10. [ ] auto-consultation;
11. [ ] concurrency hardening;
12. [ ] cross-platform release work.

Do **not** begin with autonomous trigger heuristics or sophisticated UI. First make the immutable-checkpoint consultation path reliable and auditable end to end.

---

# V1 Definition of Done

V1 is complete when:

- [ ] Pi can run with an inexpensive or local worker model.
- [ ] The extension can reuse/validate the user's OpenAI identity.
- [ ] ChatGPT operates from an isolated persistent adviser browser profile.
- [ ] The user's active browser is not automated during normal adviser work.
- [ ] One ChatGPT Project is maintained per GitHub repository.
- [ ] Separate Pi tasks use separate adviser conversations.
- [ ] Every consultation is anchored to a remotely available immutable full SHA.
- [ ] ChatGPT reads repository context through GitHub only.
- [ ] No repository archive or local source upload path exists.
- [ ] Synchronous consultation works.
- [ ] Asynchronous consultation works.
- [ ] Adviser results persist durably.
- [ ] Async results wake the correct Pi session on a best-effort basis.
- [ ] Advice includes/verifies checkpoint provenance.
- [ ] The extension reports drift between adviser checkpoint and current Pi HEAD.
- [ ] Advice action items can be dispositioned and followed up.
- [ ] Adviser unavailability normally degrades to local Pi execution.
- [ ] Core race, recovery, authentication, and git-safety cases are covered by tests.
- [ ] Supported platforms pass smoke tests.
- [ ] Normal users can install and use the extension with minimal configuration.
