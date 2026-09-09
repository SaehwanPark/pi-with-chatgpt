---
name: pwc-consultation-protocol
description: Author or implement the consultation data path for pi-with-chatgpt — git checkpoint resolution, GitHub remote reachability, git safety, consultation identity, request brief, response contract, adviser ledger, drift classification, and action-item disposition.
---

# Consultation Protocol

## When to Use

- implementing or reviewing `git/`, `protocol/`, `ledger/`, or `drift/` behaviour
- deciding what a consultation record, request brief, or response block must contain
- resolving a ref to a checkpoint, or deciding whether dispatch is allowed
- classifying checkpoint drift, or recording what happened to an adviser recommendation

Do **not** use for browser automation, authentication, ChatGPT Project/conversation mapping, or
job scheduling — those belong to `pwc-adviser-runtime`.

## Required Inputs

- the repository, branch, and requested ref (or the consultation record under review)
- the consultation kind (`consult`, `plan`, `review`, `audit`, `debug`, `challenge`)
- whether advice is `advisory` or `required`
- for drift work: current HEAD and the reviewed checkpoint

## Checkpoint Rules

The checkpoint is the temporal coordinate system for every claim the system makes.

1. Keep `requestedRef` (human-friendly, mutable) and `resolvedCommit` (**always a full commit
   SHA**, never a short SHA, branch name, tag name, or `HEAD`) as separate fields.
2. Resolve the ref **before** dispatch and persist the result. A completed or active
   consultation never moves to a newer commit, even after a force push; if the object becomes
   unavailable remotely, mark provenance `degraded` rather than retargeting.
3. Dispatch requires proof that `resolvedCommit` is reachable from the **selected** GitHub
   remote. Reachability of the branch is not the test; reachability of the object is.
4. Distinguish and return these states separately, because the worker's remedy differs:
   commit already pushed · local commit not pushed · working-tree changes only · commit
   reachable but branch moved · object no longer remote.
5. Reject non-GitHub remotes with an actionable message; do not fall back to another transport.
   Parse both SSH and HTTPS remote forms, and pick one GitHub remote deterministically when
   several exist (fork/upstream included).
6. Handle detached HEAD, worktrees, shallow clones, and PR-derived refs explicitly. A PR number
   is advisory metadata, never the anchor; if a PR HEAD moves, the recorded SHA stays authoritative.

**Git safety, non-negotiable:** a consultation never implies `git add -A`, a commit, or a push,
and a remote named `origin` is not authorisation to push. When the checkpoint is not remote,
return a structured "checkpoint not remote" result so the caller acts under ordinary git
permissions, and keep ignored/untracked files untouched.

## Brief Rules

Send what GitHub cannot supply cheaply; let the adviser read the code itself.

- Include: consultation id, kind, repository, branch, full checkpoint SHA, optional PR, goal,
  current approach, concern, exact question, and the requested review mode.
- State that the checkpoint is authoritative, that the adviser should inspect the repository
  through GitHub, that it must not implement anything or ask for pasted/uploaded files, and
  that development may advance while it reasons.
- Exclude: repository summaries, file dumps, local logs, screenshots, build output, secrets.
  V1 has exactly one code transport — a brief that "helpfully" pastes code creates a second one.

## Response Rules

Hybrid prose + structure, never strict JSON (strict JSON degrades reasoning quality; free prose
is unreliable for small worker models).

- Require: consultation id, `reviewed_commit`, status, assessment, recommendations with stable
  action IDs (`A1`, `A2`, …), risks, optional ideas.
- Preserve the **raw response text even when structured parsing is partial**; parse
  opportunistically and mark malformed or ambiguous provenance instead of failing the job or
  silently assigning a different SHA.

## Ledger and Drift

Read `references/consultation-record.md` for the record fields, protocol block layout, drift
classes, and disposition vocabulary. Two rules that are easy to get wrong:

- **Ledger before browser, response before wake-up.** Persist the job before submission and the
  result before delivery, so a crash or a missed wake-up loses neither the work nor its
  provenance. The ledger lives in global state, is append-oriented, and is not repo-visible:
  advice never becomes a file, issue, or PR comment automatically.
- **Drift is reported, not silently acted on.** Classify as `current`, `ancestor` (stale but
  possibly applicable), `diverged` (strong revalidation signal), or `unreachable` (degraded
  provenance), then compute *relevant* drift from the files/components the advice named. Do not
  reconsult merely because HEAD advanced.

## Outputs

- implementation, tests, or review findings for the surface named above
- when a decision must survive the session: `_workspace/02_design_contract.md` (via
  `pwc-milestone-orchestrator`) with the record schema and failure states
- doc sync: `CHECKPOINT_PROTOCOL.md` / `CONSULTATION_PROTOCOL.md` on any contract change

## Validation

Cover, at minimum: HTTPS and SSH remotes; fork/upstream selection; detached HEAD; branch ahead,
behind, and diverged; force-pushed branch with retained local SHA; worktree; shallow clone; no
GitHub remote; object unreachable; valid, partially malformed, empty, and SHA-mismatched
responses; duplicated completion; interrupted ledger write; ledger version migration.
