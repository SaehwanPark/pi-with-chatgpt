# pi-with-chatgpt

> **ChatGPT advises. Pi decides and executes.**

A [Pi](https://github.com/badlogic/pi-mono) extension that lets a comparatively inexpensive or
local Pi worker model consult a strong ChatGPT model as an external **senior adviser** — for
design review, implementation planning, code review, adversarial challenge, failure-mode
audits, and second opinions.

The relationship is deliberately asymmetric:

| | Owns |
| --- | --- |
| **Pi** | edits, shell, tests, git, commits, pushes, and the final decision |
| **ChatGPT** | advisory reasoning only — no execution, no orchestration, no write access |

**Status:** M4 complete — the package builds, installs into Pi, and activates with zero side effects.
The Git/GitHub checkpoint subsystem anchors every future consultation to a full commit SHA whose
availability on the selected GitHub remote is verified before dispatch; the authentication layer resolves
the Pi-side OpenAI identity, maintains an extension-owned isolated browser profile (import or manual
sign-in), and gates consultation on a capability check; and the browser runtime now launches that isolated
profile over Playwright, opens ChatGPT, classifies the surface (signed-out, human-verification, ready),
selects a model, and can carry a prompt/response turn — all behind a seam that exposes no page, selector,
or script to the worker. A full consultation round trip needs a signed-in profile (human-gated) and closes
with the M9 command flow. M4 now provides one durable Project mapping per repository, task-scoped
conversations, bounded Project/conversation recovery, and checkpoint-safe handoff text. Milestones M5–M10
(consultation protocol, UI, release) are still open; no adviser can be consulted from a command yet.
See [`docs/pi-with-chatgpt-ROADMAP.md`](docs/pi-with-chatgpt-ROADMAP.md) for the roadmap,
[`docs/pi-with-chatgpt-PROPOSAL.md`](docs/pi-with-chatgpt-PROPOSAL.md) for the product contract,
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the invariant authority,
[`docs/SECURITY.md`](docs/SECURITY.md) for the security contract, and
[`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) for how the adviser signs in without this extension
ever holding a credential.

There is **no usable adviser surface from a command yet**: `/advisor*` commands arrive in M8, and the extension
registers nothing until then by design.

## Why

Coding agents usually have an asymmetric resource profile: a cheap or local model handles most
implementation work, frontier reasoning matters only at a few decision points, and many
developers already pay for a high-limit ChatGPT subscription that stays idle during agentic
work. Making the strongest model the primary coding agent wastes that capacity; packaging and
uploading repository snapshots for a second opinion leaks context and loses provenance.

`pi-with-chatgpt` uses a **consulting model** instead, with GitHub as the shared blackboard and
git as the synchronisation protocol:

```text
        ┌─────────────────────────┐
        │         ChatGPT         │  plan / review / audit / challenge
        └────────────┬────────────┘
                     │  GitHub connector (read-only)
                     ▼
                 ┌────────┐  commit / PR / history / docs
                 │ GitHub │
                 └───▲────┘
                     │  commit + push
        ┌────────────┴────────────┐
        │           Pi            │  inexpensive or local worker model
        └─────────────────────────┘  edit / shell / tests / git
```

## How it works

- **GitHub is the only context channel in V1.** Source code reaches ChatGPT through the
  repository the user already granted access to — never through archives, uploads, tunnels, or
  a local workspace bridge.
- **Every consultation is anchored to an immutable commit SHA.** Not "ChatGPT reviewed the
  current code" but "ChatGPT reviewed `8f731e2…`".
- **The two cursors may diverge.** Pi keeps working while advice is pending; when it lands, the
  extension reports the drift between the reviewed checkpoint and current HEAD and flags which
  recommendations may need revalidation.
- **Advisory by default.** Auth expiry, quota exhaustion, or a dead browser session never blocks
  local development unless a consultation is explicitly marked `required`.
- **One ChatGPT Project per GitHub repository**, one conversation per Pi task, one dedicated
  extension-owned browser profile — the user's normal browser is never automated.
- **Advice is auditable and dispositioned.** Every consultation persists to a local ledger with
  its checkpoint, timestamps, conversation, raw response, and stable action IDs (`A1`, `A2`, …),
  which can later be marked `implemented`, `rejected_with_reason`, `superseded`, and so on.
  Advising never publishes anything to GitHub automatically.

```text
A ── B ── C ── D ── E
     ▲              ▲
  adviser        current Pi
 checkpoint       cursor        → advice stays anchored to B; Pi judges it at E
```

## Planned user surface

Names may still shift before V1 ships.

```text
/advisor <request>              senior advice on the current checkpoint
/advisor-plan <request>         implementation plan from the checkpoint
/advisor-review [request]       review a checkpoint, branch delta, or PR
/advisor-audit <request>        adversarial audit (concurrency, security, recovery)
/advisor-debug <request>        root-cause strategy from repository-visible evidence
/advisor-challenge <request>    try to invalidate a proposed design
/advisor-followup <id> <req>    continue the same task conversation
/advisor-status / -read / -cancel / -auth
```

Agent-facing primitives (`advisor_preflight`, `advisor_submit`, `advisor_read`,
`advisor_disposition`, …) keep browser, DOM, OAuth, and job internals entirely out of the worker
model's context.

A normal flow should feel like this:

```text
You: Audit this ownership design before we continue.

✓ Repository: owner/repo   ✓ Checkpoint: 8f731e2   ✓ ChatGPT adviser dispatched
Pi may continue working while the audit runs.

ChatGPT adviser completed the audit of 8f731e2.
Current HEAD: da5c991 (3 commits ahead) — relevant drift in 2 files.
A1 … A2 … A3 …
```

## Install (after the first release)

```bash
pi install git:github.com:SaehwanPark/pi-with-chatgpt
pi update --extensions
```

Try without installing, or run from a local checkout:

```bash
pi -e ./pi-with-chatgpt
```

Prerequisite: the ChatGPT GitHub connector must be able to see the target repository. The first
`/advisor-auth` run opens the isolated adviser browser once; later runs reuse the persisted
profile. Normal use needs essentially no configuration.

## Privacy and safety guarantees

- No local repository upload path exists in V1 — by design, not by default.
- Adviser output is treated as untrusted input: it cannot execute anything, grant capabilities,
  or override current code, tests, project constraints, or user instructions.
- Repository content is explicitly untrusted to the adviser (prompt-injection resistant by
  contract).
- ChatGPT/OpenAI credentials and browser session state stay in a permission-restricted profile
  outside the repository, and never appear in logs, tool output, or model context.
- A consultation never implies permission to `git add -A`, commit, or push; pushing to a remote
  named `origin` is not, by itself, authorisation.

## Repository layout

```text
AGENTS.md                       repo-wide agent contract
.agents/skills/                 repo-local agent skills (harness)
docs/                           proposal, roadmap, architecture, security, harness spec
extension/                      Pi activation, commands, agent-facing tool surface
git/                            read-only git, GitHub remote/SHA/branch inspection
auth/                           OpenAI identity discovery and manual login guidance
browser/                        isolated Playwright + system Chrome lifecycle
chatgpt/                        Project/conversation scoping; later UI adapters
jobs/                           synchronous and asynchronous job state machines
protocol/                       checkpoints, briefs, responses, ledger schemas, invariants
ledger/                         durable advice records and dispositions
drift/                          anchor-vs-HEAD classification
config/                         validated configuration (cannot carry credentials)
ui/                             TUI status + worker-facing advice projection
test/                           cross-cutting tests and the Pi-load smoke test
```

Each module exposes a documented `index.ts` barrel; `test/module-boundaries.test.ts` keeps the tree
flat and forbids competing source roots.

## Development

Work is milestone-driven; pick one roadmap item, implement it, verify, and tick the checkbox with
a named test or artifact as evidence.

The toolchain is locked in M0: **TypeScript + Node 22 + npm + vitest**.

```bash
npm ci
npm run typecheck      # tsc --noEmit over sources and tests
npm run lint           # eslint (typescript-eslint, type-aware)
npm run build          # tsc -> dist/ (what Pi loads)
npm test               # vitest
npm run smoke:pi       # build + load in Pi + `pi install` (needs Pi on PATH)
npm run verify         # all of the above
```

CI runs `verify` plus the Pi-load smoke test on `ubuntu-latest` and `macos-latest`. V1 supports
Linux and macOS only; Windows is a post-V1 platform.

Contributors and coding agents should read [`AGENTS.md`](AGENTS.md) first, then
[`docs/harness/pi-with-chatgpt/team-spec.md`](docs/harness/pi-with-chatgpt/team-spec.md).

## License

MIT — see [`LICENSE`](LICENSE). Reused dependencies are MIT, BSD-2-Clause, or Apache-2.0 licensed;
no third-party source code is vendored.
