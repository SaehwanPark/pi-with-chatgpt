# Architecture

Status: M1 (checkpoint subsystem implemented). This document is the prose authority for the architecture invariants; the
machine-readable index is `protocol/invariants.ts`, and the review checklist is
`.agents/skills/pwc-invariant-review/references/invariants.md`. When these three disagree, the most
conservative reading wins and the others are bugs to fix.

## Contract

`pi-with-chatgpt` lets an inexpensive or local Pi **worker** model consult a stronger ChatGPT
**adviser**. ChatGPT advises; Pi decides and executes. GitHub is the only shared context channel in
V1.

```
worker (Pi session)
      │  /advisor …              structured request: kind, brief, dependency mode
      ▼
extension/  ──► git/ ──► protocol/ ──► jobs/ ──► browser/ ──► chatgpt/ (ChatGPT Project + task
      │           │                        │                        conversation)
      │           │                        │
      │        drift/                  ledger/                    ▲
      └── ui/ ─────────────────────────────────────────────────────┘
```

The adviser has no path to the repository other than GitHub, and no path to execution at all.

## Module boundaries

| Module | Owns | Milestone that fills it in |
| --- | --- | --- |
| `extension/` | Pi-facing registration and lifecycle; must activate with zero side effects | M8 |
| `git/` | repository detection, checkpoint resolution, remote reachability, PR metadata, git-safety allowlist | M1 |
| `auth/` | OpenAI identity reuse, isolated browser-session bootstrap, account matching | M2 |
| `browser/` | extension-owned isolated ChatGPT runtime (Playwright over system Chrome) | M3 |
| `chatgpt/` | Project ↔ repository mapping and per-task conversations | M4 |
| `jobs/` | consultation job state machine, sync/async modes, delivery addressing | M5 |
| `protocol/` | contracts and typed invariants: anchors, context channels, trust brands, dependency mode | M6 |
| `ledger/` | durable consultation provenance, credential-free write guard | M6 |
| `drift/` | checkpoint-to-HEAD analysis and advice currency | M7 |
| `config/` | global and project-safe configuration; rejects credential-shaped input | M0+ |
| `ui/` | TUI status and the worker-facing advice surface | M8 |

`protocol/` imports nothing from the other modules, so the contracts are testable in isolation. No
module tree other than these eleven may appear at the repository root.

## Locked toolchain

Decided at M0 and recorded here so later milestones do not re-litigate it:

- **TypeScript, ESM, Node `>=22.19.0`** (the floor Pi 0.85 itself requires), npm as package manager.
- **vitest** for unit/integration tests, **eslint + typescript-eslint** for linting, `tsc` for types.
- **Playwright driving the system Chrome/Chromium binary** with an *extension-owned*
  `--user-data-dir`. No browser download (`playwright-core` is added when M3 needs it), no
  puppeteer, no CDP attach to the user's browser.
- **V1 platforms:** Linux (validated locally) and macOS (validated on CI). Windows is explicitly out
  of scope for V1.
- **One Pi dev dependency is deliberately avoided:** the extension codes against the structural
  `AdviserExtensionApi` type in `extension/pi-api.ts`, and Pi-API drift is caught by loading the
  built extension inside a real Pi installation (`npm run smoke:pi`).

## Architecture invariants

Each invariant lists where it is encoded. `planned:M<n>` means the enforcing code needs machinery
that milestone delivers; the guard marker is asserted by `protocol/invariants.test.ts`, so a
planned guard cannot quietly stay planned.

### INV-01

**No execution ownership.**

ChatGPT never edits, executes, commits, pushes, or orchestrates Pi. Encoded in
`protocol/trust.ts`: `AdviserActionSuggestion` has no command/tool/path field, and promotion to
`ApprovedAction` requires a `WorkerDecision` brand that only worker or user code can produce.

### INV-02

**GitHub-only context in V1.**

No archives, uploads, tunnels, workspace bridges, or local log/screenshot attachments. Encoded in
`protocol/context-channel.ts`: `V1_CONTEXT_CHANNELS === ["github"]`, and a
`GitHubContextReference` cannot express a local path. Non-GitHub remotes are rejected in
`protocol/repo.ts`.

### INV-03

**Immutable anchor.**

Every consultation resolves to a full commit SHA; `requestedRef` is stored separately and the anchor
is never retargeted. Encoded in `protocol/sha.ts` (only a 40-character lowercase SHA parses) and
`protocol/checkpoint.ts` (readonly `ConsultationAnchor`).

### INV-04

**Remote reachability precedes dispatch.** (implemented: `git/remote-availability.ts`, `git/checkpoint-resolution.ts`)

`checkDispatchReadiness` refuses dispatch unless the anchor reports `available`, including the
`unknown` case. The probe that produces `RemoteAvailability` (`git/remote-availability.ts` +
`git/github-api.ts`) asks GitHub about the exact object; an ambiguous answer — a 404 from a token that
cannot see the repository, a redirect, a timeout — stays `unknown` and is never promoted to
`available`. Because that host decides dispatch and holds the bearer credential, its hostname is
pinned (`ALLOWED_GITHUB_API_HOSTS`).

### INV-05

**Advice is untrusted, non-authoritative input.**

Adviser output is subordinate to code at the checkpoint, tests, project constraints, and user
instructions. Encoded in `protocol/trust.ts`: responses are plain data (`sourceCommit` provenance,
`caveats`, `suggestions`) with no callable surface, and authority claims from the adviser throw.

### INV-06

**A consultation implies no git authority.**

No blanket staging, no auto-commit, no auto-push; `origin` is not authorisation. Encoded in
`git/authority.ts`: an exact-invocation allowlist plus forbidden-argument guard, and a
`GitAuthorityToken` type the module never mints.

### INV-07

**Adviser failure is non-blocking by default.**

`DEFAULT_DEPENDENCY_MODE === "advisory"`; only `dependency: "required"` produces
`blocked-on-adviser` (`protocol/dependency.ts`).

### INV-08

**One ChatGPT Project per GitHub repository.**

`projectKeyForRepository` keys the Project on canonical `owner/repo` only, never on session, branch,
or task (`chatgpt/scope.ts`, `protocol/repo.ts`).

### INV-09

**Task conversation isolation.**

`conversationKeyForTask` requires a task identity (a repository-wide shared thread throws), delivery
is addressed by `consultationId` + `piSessionId`, and job states are an explicit allowlist
(`chatgpt/scope.ts`, `jobs/state.ts`).

### INV-10

**Account identity stability.**

`resolveAccountIdentity` is the only function that turns identity observations into a decision, so a
caller cannot get a different rule by asking a different module; without an explicit user choice the
outcome is `awaiting-user`, that choice is bound to the account pair it was made for, and plan metadata is
a hint only (`auth/identity.ts`).

### INV-11

**Isolated, extension-owned browser runtime.**

`createAdviserProfile` is the only way to obtain an `AdviserProfile`, and it refuses any directory
outside the extension state root or resembling a Chromium/Firefox user profile
(`browser/profile.ts`).

### INV-12

**Credential containment.**

Configuration that looks like credential material is rejected rather than ignored
(`config/schema.ts`), and ledger writes are scanned for credential-shaped keys and values
(`ledger/record.ts`).

### INV-13

**Worker-opaque machinery.**

The worker receives `WorkerFacingAdvisory` — advice, checkpoint provenance, drift currency, open
action items — built by allowlist, never by serialising internal state (`ui/worker-facing.ts`).

### INV-14

**Trust order.** (planned:M6)

Code at the requested commit > consultation brief > task conversation > Project instructions >
Project memory. Enforced when the request builder and response parser land in M6.

### INV-15

**Durable provenance outside model context.**

`assertPersistenceOrder` encodes "job persisted before dispatch, response persisted before wake-up",
and `LEDGER_PUBLICATION_TARGETS === ["none"]`: advice is never auto-published to a repository file,
issue, or PR (`ledger/record.ts`).

### INV-16

**V1 scope guard.**

`V1_ADVISER_PROVIDERS === ["chatgpt"]` and configuration cannot add a provider, a host, or a
transport (`protocol/provider.ts`, `config/schema.ts`). Post-V1 features stay additive.

## Failure vocabulary

Every failure must map to a job state, a worker-visible result, and a user recovery path. The
adviser path is advisory by default, so the ordinary failure outcome is
`{ kind: "adviser-failed", disposition: "degrade-to-local" }` and the local task continues. The
full matrix is in `.agents/skills/pwc-adviser-runtime/references/failure-matrix.md`.

## Verification commands

```bash
npm run typecheck   # tsc --noEmit over sources and tests
npm run lint        # eslint with type-aware rules
npm run build       # tsc → dist/
npm test            # vitest (no live ChatGPT session required, ever)
npm run verify      # all of the above, in order
npm run smoke:pi    # load the built extension inside a real Pi installation
```
