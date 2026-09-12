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

**Status:** V1.0.0 released and verified. The package builds cleanly, installs into Pi, activates with pure zero-side-effect registration, and provides 11 user-facing slash commands and 8 agent-facing tools. Every consultation anchors to an immutable git commit SHA whose availability on GitHub is verified before dispatch; isolated Playwright browser profiles keep ChatGPT session cookies protected; durable ledgers track consultations and action items; and real-time drift analysis ensures advice remains auditable and safe as local code evolves. All architecture invariants (INV-01 through INV-16) are enforced across the runtime.

See [`docs/pi-with-chatgpt-ROADMAP.md`](docs/pi-with-chatgpt-ROADMAP.md) for the roadmap,
[`docs/pi-with-chatgpt-PROPOSAL.md`](docs/pi-with-chatgpt-PROPOSAL.md) for the product contract,
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the invariant authority,
[`docs/SECURITY.md`](docs/SECURITY.md) for the security contract,
[`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) for authentication details,
[`docs/CHECKPOINT_PROTOCOL.md`](docs/CHECKPOINT_PROTOCOL.md) for checkpoint resolution,
[`docs/CONSULTATION_PROTOCOL.md`](docs/CONSULTATION_PROTOCOL.md) for protocol and durable storage, and
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) for configuration and error resolution.

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

## User Surface

### User Slash Commands

| Command | Purpose |
| --- | --- |
| `/advisor <request>` | General senior advice on the current checkpoint |
| `/advisor-plan <request>` | Implementation planning anchored to checkpoint |
| `/advisor-review [request]` | Code review of current commit, branch delta, or PR |
| `/advisor-audit <request>` | Adversarial audit (concurrency, security, recovery) |
| `/advisor-debug <request>` | Root-cause analysis from repository-visible evidence |
| `/advisor-challenge <request>` | Challenge proposed design and surface trade-offs |
| `/advisor-followup <id> <req>` | Continue prior task conversation with drift awareness |
| `/advisor-status [id]` | Show consultation status and graph/file drift |
| `/advisor-read [id]` | Expand full advisory response in markdown |
| `/advisor-cancel <id>` | Cancel in-flight consultation |
| `/advisor-auth` | Inspect authentication and launch browser login |

### Agent-Facing Tools

Pi workers can consult the adviser programmatically through 8 tools:
- `advisor_preflight`: Pre-check remote reachability of commit SHA before dispatch.
- `advisor_submit`: Submit consultation and record in durable ledger.
- `advisor_read`: Read full markdown advisory and structured action items.
- `advisor_status`: Query graph and file drift against current HEAD.
- `advisor_followup`: Continue task conversation with action-item context.
- `advisor_cancel`: Cancel in-flight consultation without worker blocking.
- `advisor_auth`: Check credential and browser profile status safely.
- `advisor_disposition`: Record worker action-item disposition with required rationale.

A normal flow feels like this:

```text
You: /advisor-audit Audit this ownership design before we continue.

[advisor:audit] dispatching adv-4f2a-1 (owner/repo@8f731e2, sync)
Pi may continue working while the audit runs.

ChatGPT adviser completed the audit of 8f731e2.
Current HEAD: da5c991 (3 commits ahead) — relevant drift in 2 files.
A1: enforce owner-only permissions on state directory
A2: add divergence test for remote force-push
```

## Installation

Install directly into Pi:

```bash
pi install git:github.com/SaehwanPark/pi-with-chatgpt
```

Or run directly from a local clone:

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
