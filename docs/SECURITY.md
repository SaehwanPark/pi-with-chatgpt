# SECURITY.md — Security Contract and Threat Model

This is the security authority for `pi-with-chatgpt`. It states what the extension refuses to
make possible, which invariants enforce it, and where each is enforced in code. The full invariant
prose is [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

## Trust boundaries

| Boundary | What crosses it | What never crosses it |
| --- | --- | --- |
| Pi worker model → extension | A consultation request (question, mode, dependency) | Credentials, browser state, job machinery internals |
| ChatGPT → Pi | An advisory report (markdown + action items) | Executable authority, tool results, git/merge authority |
| Browser → disk | Session state inside the extension-owned profile | Cookies/tokens into logs, telemetry, git, or model context |
| ChatGPT page → Pi worker | A surface state, a bounded scrubbed `explanation`, and the answer text | Raw DOM, input values, cookies, unscrubbed page text, a page/driver/selector the worker could drive |
| Extension → browser | A prompt string and a resolved model id, typed into the composer as data | Selectors or scripts supplied by the worker, navigation to non-ChatGPT hosts, coordinate/script injection |
| Git → repository | Explicit, staged, user-authorised commits | `git add -A`, auto-push, merge, force-push, token disclosure |
| Repository → ChatGPT | Nothing directly; only what is visible on GitHub | Archives, file uploads, tunnels, workspace bridges |
| Extension → GitHub API | Read-only `GET` of commit/PR existence for the selected `owner/repo`, over TLS, with an injected token | Write scopes, non-`api.github.com` hosts, redirect targets (`redirect: "manual"`), tokens in errors and diagnostics |

## Invariants that are security properties

| ID | Property | Enforced by |
| --- | --- | --- |
| INV-01 | The adviser has no execution ownership | `browser/runtime.ts` + `browser/runtime-types.ts` (`AdviserBrowserRuntime` exposes only `status`/`ensureReady`/`probeSurface`/`discoverModels`/`consult`/`shutdown`; no page, context, driver, selector, or script accessor — asserted by `runtime.test.ts` "exposes no accessor that could address the page") |
| INV-02 | No non-GitHub source transport in V1 | `protocol/context-channel.ts` (`V1_CONTEXT_CHANNELS === ["github"]`), `protocol/repo.ts` (`supportedGitHubHosts`, `credentials-in-url` rejection), `git/authority.test.ts` (prohibited-path source scan) |
| INV-05 | Adviser output is untrusted, non-authoritative input | `protocol/trust.ts` (`AdviserText` provenance brand, `assertNotAdviserAuthored`, `ApprovedAction` requires a `WorkerDecision`), `browser/playwright-driver.ts` (`safeSelectorFragment`: text read off the page — a model id from the picker — can never address an element other than a model option) |
| INV-06 | A consultation implies no git authority | `git/authority.ts` (`READ_ONLY_GIT_INVOCATIONS` allowlist, `FORBIDDEN_GIT_ARG_TOKENS` incl. file-write/exec arguments such as `--output`, `--ext-diff`, `--upload-pack`, `-c`) |
| INV-04 | The adviser is never shown work that is not published on GitHub | `git/remote-availability.ts` (`assessCheckpointAvailability`, `isDispatchPermitted`), `git/github-api.ts` (exact-object probe; a 404 is only `absent` when the repository itself is visible), `protocol/checkpoint.ts` (`checkDispatchReadiness` refuses `unknown` and `unavailable`) |
| INV-08 | One Project per canonical repository identity | `protocol/repo.ts` (`canonicalRepositoryKey`) + `chatgpt/scope.ts` (`projectKeyForRepository`) + `chatgpt/project-mapping.ts` (`ensureProjectForRepository` under the `projects` state lock) |
| INV-09 | Task conversations are isolated and writes are serialised | `chatgpt/scope.ts` (`conversationKeyForTask`) + `chatgpt/conversation-mapping.ts` (`KeyedMutex`) + `chatgpt/conversation-recovery.ts` (cross-process lock and same-Project replacement) + `browser/playwright-driver.ts` (driver-owned lock across the shared tab) |
| INV-10 | No silent OpenAI/ChatGPT account switch | `auth/identity.ts` (**single authority** `resolveAccountIdentity` answers every case; `compareAccountIdentity`, namespace-scoped `accountIdNamespace`, pair-bound `decideAccountMismatch` — only a `keep-current` minted for this account pair resolves a mismatch, and there is no boolean override), `auth/adviser-auth.ts` (`resolveAdviserAuth` delegates to it and holds no second copy of the rule) |
| INV-11 | Isolated, extension-owned browser runtime; the user's active browser is never automated | `browser/profile.ts` (`createAdviserProfile`, `isLikelyUserBrowserProfile`, `ProfileOwnershipError`), `browser/state-storage.ts` (ownership marker read before any write, `0700`/`0600`, `writePrivateFileNoFollow`/`symlink-refused`, `assertPrivateDirectory`), `browser/cookie-import.ts` (copy-only allowlist, refuses running source / self-import / non-empty destination / path escape, `Local State` scrub, `authorizeChromeStateImport` → `applyChromeStateImport(plan, authorization)`), `auth/login-flow.ts` (`AdviserLoginPort` has no click/type/navigate/solve method), `protocol/adviser.ts` (`import-chrome-state` is human-gated), `browser/runtime.ts` (`consult()` refuses on a non-actionable surface rather than pushing through a challenge; observation stays available so a completed manual login can be detected), `browser/chatgpt-dom.ts` (a Cloudflare interstitial is `human-verification`, never `unknown` a caller retries through) |
| INV-12 | Credentials never enter logs, ledger, config, or model context | `config/schema.ts` (`FORBIDDEN_CONFIG_KEYS`), `ledger/record.ts` (`assertLedgerRecordSafe` with `SENSITIVE_LEDGER_KEY_PATTERN` / `SENSITIVE_VALUE_PATTERNS`), `chatgpt/project-mapping.ts` + `chatgpt/conversation-mapping.ts` (`assertCredentialFreeValue` before M4 state writes), `auth/secret-text.ts` (`SecretText` inert under coercion/inspect), `auth/status.ts` (`adviserStatus` masked fields + `assertStatusIsRedacted`), `auth/pi-credential.ts` (refresh token dropped at parse), `protocol/masking.ts` + `browser/chrome-state.ts` (account metadata masked while parsing), `browser/diagnostics.ts` (DOM dumps redact credential-shaped attributes; screenshots refused before login) |
| INV-13 | Worker sees only a purpose-built advice surface | `ui/worker-facing.ts` (`toWorkerFacingAdvisory` projection, `WORKER_FACING_FORBIDDEN_KEY_PATTERN`), `browser/chatgpt-dom.ts` (`scrubPageText` strips credential shapes from page-derived strings), `browser/playwright-driver.ts` (`#snapshot` reads presence only) |
| INV-15 | Provenance persists before dispatch and before wake-up, and is never auto-published | `ledger/state-store.ts` (private atomic M4 state writes) + `ledger/record.ts` (`assertPersistenceOrder`, `LEDGER_PUBLICATION_TARGETS === ["none"]`) |

The canonical statement of each invariant is
[`references/invariants.md`](../.agents/skills/pwc-invariant-review/references/invariants.md);
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) is the prose authority and `protocol/invariants.ts` is the
machine-readable index.

## Credential containment

- **Identity discovery** reads the OpenAI/Codex identity from the Pi auth store to recognise *which*
  account the adviser browser session should belong to. The contract in `auth/identity.ts` is limited
  to an account hint, a masked email, and a plan hint: there is no field in which a token can be
  carried, and a mismatch can only be resolved by an explicit user choice. A stored API key resolves to
  *no* identity (`piApiKeyIdentity` returns `source: "none"`), so a transport credential can never
  "match" a browser account.
- **Cookie import never decrypts anything.** The copy inherits Chromium's own encryption and the real
  browser decrypts it with the OS key at runtime; there is no decryption path in this repository, so
  there is no key material to leak (macOS Keychain / Linux libsecret).
- **Status output is built from masked fields.** `adviserStatus` returns an account-id *prefix*, a masked
  email, and a plan hint; `assertStatusIsRedacted` rejects a status that grew a credential-shaped key or
  a JWT-prefixed value, so a future field cannot regress it quietly.
- **Tokens are never an input** to any module in this repository. No function in `auth/`, `browser/`,
  `chatgpt/`, `jobs/`, `ledger/`, or `protocol/` accepts one.
- **Config cannot carry credentials**: `parseAdviserConfig` rejects every credential-shaped key
  instead of ignoring it, and rejects keys that would redirect the browser profile or state root.
- **A credential-bearing remote URL is refused**, not silently canonicalised:
  `parseGitHubRemote("https://user:token@github.com/o/r")` returns `credentials-in-url`, because a URL
  that contains a secret must never become a repository key or a log line (INV-12).
- **Ledger records are scanned** before persistence (`assertLedgerRecordSafe`) for credential-shaped
  keys and for these value shapes: `Bearer …`, GitHub PAT prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`,
  `ghr_`, `github_pat_`), `sk-` provider keys, `Cookie:`/`Set-Cookie:` headers, and PEM private-key
  blocks. Generic high-entropy/base64 detection is deliberately **not** used: raw adviser prose is
  stored in the same record, and a heuristic that rejects base64 would reject legitimate advice rather
  than protect it. The scan is an additional tripwire, not the primary design — the primary design is
  that session material has nowhere to be written.

## Human-gated actions

`protocol/adviser.ts` splits every "what happens next" action in two: the ones the extension may perform
on its own, and the ones a person must take. Only four are automatic — `create-profile` (an empty
extension-owned directory), `run-capability-probe` (read-only navigation in the adviser's own profile),
`wait-for-rate-limit`, and `consult`. Everything else is gated, including `import-chrome-state`: copying
cookies out of the user's real browser profile is the most sensitive browser touch in the product and is
strictly more sensitive than opening an adviser window, which was already gated. `protocol/adviser.test.ts`
pins both halves of that split by enumeration, so adding an action forces an explicit decision instead of
inheriting whatever the previous entry was.

The list is the *policy*; the enforcement sits at the effect. `applyChromeStateImport(plan, authorization)`
refuses an import that carries no human authorization, and `authorizeChromeStateImport` mints one only when
the caller states the confirmation phrase — so the gate cannot be reached by plumbing that never asked a
person, and `rg -n confirmedByHuman` lists every call site that may. An action is not gated because it is
named in a table.

## Browser runtime containment (M3)

- **The page is untrusted input.** The DOM probe reads *presence* only — is a composer, sign-in affordance,
  error banner, or challenge here — never input values, cookies, or full page text. Text that survives to a
  caller is the short `explanation`, run through `scrubPageText` (JWT/`sk-`/`Bearer`/`cookie=` shapes).
  Where this text later enters worker context it is bounded and treated as adviser-authored (INV-05); M6's
  prompt assembler must not paste raw `explanation` fields without that provenance.
  The one exception is the consultation answer itself (`ConsultationOutcome.text`): it is adviser-authored
  page text and is deliberately *not* scrubbed or truncated, because a cut-off or mangled answer is a
  failed consultation. It is bounded by nothing on this side of the boundary, so it must reach a worker only
  through `protocol/trust.ts` branding (M6) and never through `ui/worker-facing.ts`'s projection unchanged.
- **The surface is ChatGPT or nothing.** `classifySurface` returns `unknown`/not-actionable for any non-
  ChatGPT host, so a page that redirected elsewhere is never used as an adviser channel.
  The navigation test pins the one URL the driver can visit.
- **Page text never becomes a selector.** The only selector built from a string is the model-menu match,
  and `safeSelectorFragment` reduces it to model-name characters or refuses it outright: the driver never
  emits `:has-text("")` (which matches every menu entry) and never lets a label containing `")` open a new
  selector clause. Model ids arrive from `listModels()`, i.e. from the page, so this is page input reaching
  an interaction path, and it is treated as such (INV-05).
- **A human gate blocks consultation, never observation** (INV-11). Solving a challenge is a human act, so
  `consult()` refuses while the surface is non-actionable and no automatic retry is offered. Reading the page
  to ask "has the person finished?" is not automating the challenge and must stay possible — latching the gate
  as a blanket refusal would deadlock manual login, because opening the window is itself a `signed-out`
  observation. Only the launch-retry circuit breaker refuses `ensureReady`, and it trips on a proven transport
  failure rather than on a page the human may still be fixing.

- **Diagnostics refuse to capture a login screen.** Screenshots are written only for surface states past
  login; DOM dumps redact credential-shaped attribute values; everything is `0600` inside the git-ignored
  diagnostics dir; retention is bounded by age and count. The key test asserts the pre-login screenshot is
  refused, because that is the one mistake that would publish a credential.
  The diagnostics dir is part of the owned state tree: `prepareStateStorage` creates it `0700` and re-reads
  its mode, because `mkdir`'s mode is umask-masked and ignored for a directory that already exists.

## Project and conversation state (M4)

The M4 state tree is derived in one place (`config/state-layout.ts`) below the extension-owned root:
`projects.json` maps canonical `owner/repo` identities to opaque Project ids, and one digest-named file in
`conversations/` maps each task/kind to an opaque conversation id. URLs are canonical display metadata and
are checked against their ids; they are never used as identity or arbitrary navigation input. The state
store writes private temporary files and atomically renames them, refuses symlink targets, and uses owner-only
directories/files (`ledger/state-store.ts`).

An inconclusive browser probe keeps an existing mapping. Only positive deletion evidence permits recreation;
a replacement conversation stays in the existing Project and returns a checkpoint-naming handoff brief. The
handoff does not carry repository prose or claim that Project memory is provenance. The browser adapter uses
only the runtime's already-owned tab; a driver-owned exclusive operation lock prevents it from interleaving
with consultation, login, or model navigation, and it returns a structured refusal when the ChatGPT surface
cannot be recognised. Live ChatGPT interaction remains a manual validation drill, not a unit-test dependency.

## Durable consultation jobs (M5)

`jobs/record.ts` validates a closed, versioned job shape and refuses an unverified or mismatched
GitHub anchor. `jobs/store.ts` uses private atomic writes and per-consultation same-host locks;
creation cannot overwrite a record, and claims and terminal transitions cannot rewrite its identity.
Response files carry the job/repository/task/checkpoint binding and a text digest to detect corrupted
or substituted artifacts. This is corruption detection, not cryptographic attestation against the
state-directory owner.

Pi delivery routing uses a SHA-256 digest of the originating Pi session identifier. Raw Pi session
identifiers and ChatGPT credentials are absent from job records; internal delivery digests, Project
and conversation identifiers, and paths must also stay out of worker-facing output. All stored text
passes the existing credential scan. Raw filesystem exceptions are replaced with fixed storage codes.
The store refuses managed directory/file symlinks and never submits, wakes, executes, or publishes.

## Prompt injection posture

Repository content is untrusted input to the adviser, and adviser output is untrusted input to the
worker. The extension never instructs the worker to treat advice as authoritative, never executes
commands embedded in advice, and never follows URLs from advice except to report them. Action items
are data with stable IDs and a disposition; they are not instructions.

## What V1 does not do

- No secret scanning, signing, or attestation pipeline (post-V1 backlog).
- No multi-user or shared-machine isolation beyond file permissions on the profile and state
  directories.
- No Windows-specific security claims (platform is deferred to post-V1).

## Reporting

Report vulnerabilities through the repository's private security channel. Include the extension
version (`package.json`), the Pi version, the OS, and the reproduction steps — never your ChatGPT
session state, cookies, or tokens.
