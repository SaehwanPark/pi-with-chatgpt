---
name: pwc-milestone-orchestrator
description: Take one pi-with-chatgpt roadmap milestone or roadmap item (M0-M10) from scope to verified, invariant-clean, checked-off state. Use for any feature, module, or hardening work in this repository.
---

# Milestone Orchestrator

## When to Use

- implementing or continuing a roadmap item from `docs/pi-with-chatgpt-ROADMAP.md`
- starting or finishing work in a milestone area (`git/`, `auth/`, `browser/`, `chatgpt/`,
  `jobs/`, `protocol/`, `ledger/`, `drift/`, `config/`, `ui/`)
- verifying that a milestone's exit criteria are actually met before claiming it is done

Do **not** use for pure document reads, release/PR logistics, or advisory-protocol design
questions that need no code change — those go to `pwc-consultation-protocol` or a direct answer.

## Required Inputs

- one milestone id or one checklist item (if more than one is offered, confirm the unit of work)
- current branch and `git status` cleanliness expectation
- any user constraint that overrides the roadmap (scope cut, platform cut, "no UI yet")
- if toolchain is not yet established (pre-M0 exit), the agreed build/test command

## Architecture

Pipeline with one Producer-Reviewer gate. Coordination stays shallow: `orchestrator -> worker`.

| Phase | Owner | Output |
| --- | --- | --- |
| 1 Scope | orchestrator | `_workspace/01_scope_item.md` |
| 2 Design | orchestrator (or worker) | `_workspace/02_design_contract.md` |
| 3 Implement | worker | source diff + tests |
| 4 Verify | worker | `_workspace/04_verify_report.md` |
| 5 Invariant review | reviewer (`pwc-invariant-review`) | `_workspace/05_review_findings.md` |
| 6 Close | orchestrator | roadmap checkbox + doc sync + commit |

Run phases 1→5 in order. Skip a phase only when it has no possible content (for example, no
new persisted state means phase 2 has no schema section) and say so in the phase artifact.

## Phase 1: Scope

Write down, in `_workspace/01_scope_item.md`: the exact roadmap line item(s), the modules and
files expected to change, the exit criteria quoted from the roadmap, explicit non-goals, and
the post-V1 items this item might tempt you into (archive upload, non-GitHub host, second
provider, publish-to-PR). Naming the temptation is what keeps V1 small.

## Phase 2: Design Contract

Before editing, state the contract this change must satisfy:

- **Invariants** touched, by ID from `pwc-invariant-review/references/invariants.md`.
- **Data shape** for anything persisted or sent (job record, ledger record, protocol block).
- **Failure modes** for the new path and the observable behaviour of each (see
  `pwc-adviser-runtime/references/failure-matrix.md`).
- **Ownership** of any shared mutable state (conversation, ledger file, browser session,
  job record) and how concurrent access is serialised or isolated.
- **Test plan**: named test cases, including at least one failure case.

If the design would need a new transport, a new capability for the adviser, or a relaxed
invariant, stop and escalate instead of implementing.

## Phase 3: Implement

- Smallest change that satisfies the contract, inside the planned module boundary.
- Prefer explicit typed boundaries over runtime checks; encode an invariant in a type or a
  test when the roadmap asks for it.
- Never widen adviser privileges, add an upload path, or automate the active browser as a
  convenience while implementing something else.
- Keep browser/protocol internals out of worker-facing prompt text and user transcripts.

## Phase 4: Verify

- Run the narrowest stage that covers the change, then the project suite for milestone close.
- Cover the contract's failure cases, not only the happy path.
- Record commands run and results in `_workspace/04_verify_report.md`; a failing or unrunnable
  check is reported, never described as passing.

## Phase 5: Invariant Review

Run `pwc-invariant-review` against the diff. Fix every `blocker`; record `major` findings with
an explicit decision. Do not merge an empty review — "no findings" must name the invariants
checked.

## Phase 6: Close

1. Tick only the roadmap checkboxes that are actually satisfied; leave related items unticked.
2. Sync docs that the change invalidates (protocol, state layout, commands, invariants,
   `CHANGELOG.md`).
3. Commit with a message that names the milestone and the invariant-relevant behaviour.
4. Push only when the user or surrounding workflow authorised pushing.

## Handoff Rules

- Durable artifacts (scope, design, verify, review) exist because a later session must be able
  to resume or audit the milestone without rereading the diff.
- Keep each artifact readable in one screen; cite paths and commands rather than re-deriving
  reasoning.
- `_workspace/` is local scratch and gitignored; promote durable conclusions into `docs/`.

## Failure Policy

- **Missing context** (roadmap ambiguity): ask one targeted question; do not guess a scope cut.
- **Design violates an invariant**: block the milestone, record the conflict in
  `_workspace/02_design_contract.md`, and escalate.
- **Verification cannot run**: milestone stays open; report the exact command and error.
- **Partial implementation**: keep the branch honest — unticked checkbox plus a note stating
  what remains, rather than a ticked checkbox with caveats.
- **Worker/child failure**: preserve partial artifacts, mark the phase `blocked`, never invent
  coverage.

## Removable Logic

Model- or vendor-specific heuristics (retry counts, polling backoff, DOM-adapter workarounds,
"ask the adviser when confused" triggers) belong in `pwc-adviser-runtime/references/` marked
removable, never in this orchestrator and never in `AGENTS.md`.

## Delegation Notes

Delegate only genuinely independent, bounded slices: broad repository reconnaissance, log or
test-fixture analysis, one review pass, or platform-specific test runs with non-overlapping
files. Writes to shared state (`git/`, `ledger/`, `jobs/`, browser session) stay single-owner.
The orchestrator owns synthesis and the close-out decision.
