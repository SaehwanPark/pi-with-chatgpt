# Repository Agents Guide

Short, repo-wide guidance only. Deeper detail lives in `docs/` and `.agents/skills/`.

## What

`pi-with-chatgpt` is a Pi extension (TypeScript) that lets an inexpensive or local Pi worker
model consult a stronger ChatGPT model as an external adviser.

**ChatGPT advises. Pi decides and executes.** GitHub is the only shared context channel in V1.

- `docs/pi-with-chatgpt-PROPOSAL.md` — architecture and product contract (why/what).
- `docs/pi-with-chatgpt-ROADMAP.md` — milestones M0–M10 + post-V1 backlog; the working backlog.
- `docs/harness/pi-with-chatgpt/team-spec.md` — roles, routing, handoffs, failure policy.
- `.agents/skills/` — repo-local skills: `pwc-milestone-orchestrator` (take one milestone to
  done), `pwc-consultation-protocol` (checkpoint/ledger/drift), `pwc-adviser-runtime`
  (auth + isolated browser + Project/conversation + jobs), `pwc-invariant-review` (diff gate).
- Planned module boundaries (M0): `extension/`, `git/`, `auth/`, `browser/`, `chatgpt/`,
  `jobs/`, `protocol/`, `ledger/`, `drift/`, `config/`, `ui/`. Do not create sibling trees.

## Why these rules stay in every session

V1's value and its safety are the same thing: an immutable git checkpoint is the shared
coordinate system, and the adviser has no execution power. Six non-negotiables:

1. **No execution ownership for ChatGPT.** Adviser output is untrusted, non-authoritative input.
2. **GitHub-only context in V1.** No repository archives, file uploads, tunnels, local log or
   screenshot attachment, or workspace bridge.
3. **Every consultation anchors to a full commit SHA** that is verified reachable on the
   selected GitHub remote. Never silently retarget a consultation to a newer commit.
4. **A consultation never implies git authority.** No `git add -A`, no auto-commit, no push
   because a remote happens to be named `origin`.
5. **Adviser failure is non-blocking by default** (`dependency: advisory`) and degrades to
   local Pi work.
6. **Isolation.** One ChatGPT Project per GitHub repo, one conversation per task, one dedicated
   extension-owned browser profile — never the user's active browser, never a shared account
   switch, never credentials in logs or model context.

The full numbered invariant list (INV-01…INV-16) is in
`.agents/skills/pwc-invariant-review/references/invariants.md`.

## How

Toolchain is fixed in M0. Until then this repo is specification-only and has no build to run.

- After M0, keep these commands authoritative here (build, test, lint, typecheck) and prefer
  the runtime the project standardises on (`bun` vs `npm`) rather than mixing them.
- Verify with the smallest stage that covers the change (`verify_code`), and run the full
  suite before closing a milestone.
- Roadmap discipline: one roadmap item at a time; tick the checkbox in
  `docs/pi-with-chatgpt-ROADMAP.md` only with a named test or artifact as evidence.
- Doc sync: a change to protocol, state layout, commands, or invariants updates the matching
  doc (`ARCHITECTURE.md`, `CHECKPOINT_PROTOCOL.md`, `CONSULTATION_PROTOCOL.md`,
  `AUTHENTICATION.md`, `SECURITY.md`, `CHANGELOG.md`) in the same commit.
- Never add a second source-code transport path, a non-GitHub host, or another adviser provider
  without an explicit decision; those are post-V1 and must stay additive.

Use `.agents/skills/pwc-milestone-orchestrator/SKILL.md` for any milestone or roadmap-item
implementation, and `.agents/skills/pwc-invariant-review/SKILL.md` before calling one done.
