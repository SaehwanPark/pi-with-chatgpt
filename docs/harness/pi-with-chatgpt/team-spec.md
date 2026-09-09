# pi-with-chatgpt Harness Team Spec

Portable coordination contract for this repository. Runtime-specific settings are optional and
must be removable without changing anything here.

- **Architecture:** Pipeline (roadmap milestones are sequentially dependent) with a
  Producer-Reviewer gate at invariant review, and an Expert-Pool style routing table for the
  three specialists.
- **Depth:** `orchestrator -> worker`. No deeper coordination layer without explicit
  justification.
- **Canonical inputs:** `docs/pi-with-chatgpt-PROPOSAL.md`, `docs/pi-with-chatgpt-ROADMAP.md`,
  `AGENTS.md`.

## Roles

| Role | Responsibility | Skill | Writes |
| --- | --- | --- | --- |
| milestone-orchestrator | Turn one roadmap item into verified, invariant-clean, checked-off work; owns sequencing, close-out, and escalation | `.agents/skills/pwc-milestone-orchestrator/SKILL.md` | `_workspace/01_*`, `_workspace/02_*`, roadmap/doc edits |
| consultation-protocol-worker | Checkpoint identity, git safety, brief/response contract, ledger, drift, disposition | `.agents/skills/pwc-consultation-protocol/SKILL.md` | `git/`, `protocol/`, `ledger/`, `drift/` + tests |
| adviser-runtime-worker | Identity reuse, isolated browser profile, capability checks, Project/conversation mapping, job engine | `.agents/skills/pwc-adviser-runtime/SKILL.md` | `auth/`, `browser/`, `chatgpt/`, `jobs/` + tests |
| invariant-reviewer | Independent review of a delta against INV-01…INV-16; severity-ranked findings; merge verdict | `.agents/skills/pwc-invariant-review/SKILL.md` | `_workspace/05_*` only (no implementation edits) |

Model policy is semantic, never a model id: orchestrator `inherit`, protocol/runtime workers
`balanced`, invariant reviewer `strong` with reasoning depth over speed. Concrete providers or
models belong only in a removable runtime override.

## Routing

| Request shape | Route to |
| --- | --- |
| "Implement M5 job engine", "finish this roadmap item" | milestone-orchestrator (then specialists) |
| Checkpoint resolution, ledger schema, drift class, protocol shape | consultation-protocol-worker |
| Login, browser, capability, Project/conversation, async delivery | adviser-runtime-worker |
| "Review this branch/PR", "is this allowed?", pre-merge gate | invariant-reviewer |
| Ambiguous or cross-cutting | milestone-orchestrator picks one owner; ambiguous *permission* questions always go to the reviewer |

## Handoff contract

| Handoff | Class | Producer → consumer | Path | Done state |
| --- | --- | --- | --- | --- |
| Milestone scope | durable artifact | orchestrator → worker | `_workspace/01_scope_item.md` | `scoped` |
| Design contract | durable artifact | orchestrator → worker | `_workspace/02_design_contract.md` | `design-agreed` or `blocked` |
| Verification report | durable artifact | worker → reviewer | `_workspace/04_verify_report.md` | `verified` / `failed` |
| Review findings | durable artifact | reviewer → orchestrator | `_workspace/05_review_findings.md` | `clean` / `fix-then-merge` / `block` |
| Status, quick clarification | ephemeral | either way | thread only | not persisted on purpose |

Naming stays deterministic: `_workspace/{phase}_{role}_{artifact}.md`. `_workspace/` is local,
gitignored scratch; conclusions that must outlive the session are promoted to `docs/` or the
roadmap, never left in scratch.

## Ownership and isolation

- Single-owner files by default. `git/`, `ledger/`, `jobs/`, and the browser session are
  exclusive-ownership resources; enforcement is advisory unless a runtime enforces it, and an
  advisory claim is never described as exclusive.
- Parallel work is allowed for read-heavy reconnaissance, review passes, fixture/log analysis,
  and platform-specific test runs with non-overlapping files.
- Parallel writes to shared state, or stateful tests sharing the adviser profile or ledger, are
  serialised or run in isolated environments. Synthesis is not a repair mechanism.

## Failure policy

- **Spawn/permission unavailable** → orchestrator does the work inline and says so.
- **Specialist unavailable** → route to the reviewer for the safety-relevant subset only.
- **Partial worker failure** → keep partial artifacts, mark the phase `blocked`, never fabricate
  coverage or a passing verification.
- **Conflicting findings** → reviewer verdict wins on invariants; the user decides scope and
  product trade-offs.
- **Invariant conflict with a requirement** → stop and escalate; never relax INV-01…INV-16 to
  make progress.
- **Missing capability in the runtime** (no isolation, no messaging, no ownership enforcement) →
  degrade explicitly in the phase artifact and choose the next weaker guarantee: mechanical
  ownership → isolated workspace → non-overlapping ownership → serialised execution.

## Removable layers

`.agents/skills/` and this spec are the contract. Native adapter output (`.codex/agents/`,
`.cursor/agents/`, generated profiles) is a compiled convenience: deleting it must leave this
spec, the skills, and the `_workspace/` contract fully usable. Never let generated output become
the source of truth by accident.
