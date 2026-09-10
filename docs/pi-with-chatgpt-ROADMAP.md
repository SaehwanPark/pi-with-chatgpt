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
  `config/schema.ts`, `ui/worker-facing.ts`; `INV-04` and `INV-14` are explicitly `planned:M1`/
  `planned:M6` and asserted to stay that way by `protocol/invariants.test.ts`.
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
in `docs/CHECKPOINT_PROTOCOL.md`. Verified by `git/*.test.ts` (137 tests across 10 files) and
`test/git-integration.test.ts` (9 tests against real git repositories: worktrees, shallow clones,
detached HEAD, tag/abbreviated resolution, divergence, and a real `file://` force-push that keeps the
retained local SHA authoritative). `npm run verify` green: typecheck, lint, build, 293 tests, Pi smoke
(Pi 0.85.1). Design decision recorded in `docs/CHECKPOINT_PROTOCOL.md` §7: the consultation *identity*
is repo + requested ref + full SHA + optional PR + availability; the branch is carried as working-state
context and is deliberately not part of identity, because a branch can be renamed, deleted, or rebased
while advice is still being applied (INV-03).

---

# M2 — OpenAI Identity and Isolated ChatGPT Authentication

## Pi OpenAI/Codex Identity Reuse

- [ ] Discover Pi's existing OpenAI/Codex OAuth credential through supported Pi abstractions.
- [ ] Avoid directly reimplementing Pi token refresh if a supported API exists.
- [ ] Read account identity metadata where safely available.
- [ ] Read plan/entitlement hints where available.
- [ ] Treat plan metadata as a hint, not the final capability check.
- [ ] Ensure the active Pi worker model need not be OpenAI.
- [ ] Support a local/Qwen worker while reusing stored OpenAI identity.
- [ ] Consider Codex CLI identity as an optional secondary source only if needed.

## Dedicated Adviser Browser State

- [ ] Define OS-appropriate state directories.
- [ ] Create isolated ChatGPT profile storage.
- [ ] Enforce restrictive filesystem permissions.
- [ ] Ensure browser credentials are never exposed to the worker model.
- [ ] Ensure cookies/tokens are never written to normal logs.

## Chrome/Chromium Import Bootstrap

- [ ] Detect supported local Chromium-family profiles.
- [ ] Make import an explicit authentication/repair action.
- [ ] Open source browser profile read-only.
- [ ] Import only the state necessary to seed the isolated adviser profile.
- [ ] Never automate the user's active browser for normal jobs.
- [ ] Verify the imported isolated profile can access ChatGPT.
- [ ] Handle encrypted cookie storage on supported OSes.
- [ ] Provide clear recovery when cookie import is impossible.

## Manual Login Fallback

- [ ] Open the isolated adviser browser when no usable session exists.
- [ ] Allow user login, CAPTCHA, 2FA, or consent steps.
- [ ] Detect successful ChatGPT authentication.
- [ ] Persist the isolated profile.
- [ ] Avoid asking again during normal use.

## Account Matching

- [ ] Compare Pi OpenAI identity with ChatGPT browser identity where possible.
- [ ] Detect likely account mismatch.
- [ ] Never silently switch to a different ChatGPT account.
- [ ] Provide an explicit user choice/recovery path on mismatch.

## Capability Verification

- [ ] Verify ChatGPT access.
- [ ] Verify intended strong adviser model or best available equivalent.
- [ ] Verify GitHub connector availability.
- [ ] Verify target repository visibility before first consultation.
- [ ] Cache capability checks conservatively.
- [ ] Revalidate on meaningful auth/provider failures.

## Tests

- [ ] valid persisted adviser profile;
- [ ] expired ChatGPT session;
- [ ] Pi OAuth present + browser auth absent;
- [ ] browser auth present + Pi OAuth absent;
- [ ] account mismatch;
- [ ] Chrome import success;
- [ ] Chrome import failure;
- [ ] manual login recovery;
- [ ] quota/model unavailable;
- [ ] GitHub connector unavailable.

## Exit Criteria

- [ ] A Pi session using a local/non-OpenAI worker can authenticate and use a paid ChatGPT adviser without repeatedly logging in.

---

# M3 — Adviser Browser Runtime

## Runtime Ownership

- [ ] Choose browser automation implementation.
- [ ] Keep browser control extension-owned rather than worker-operated.
- [ ] Create a reusable isolated ChatGPT runtime.
- [ ] Avoid using the user's normal Chrome profile in production.
- [ ] Avoid global browser-state conflicts with other Pi extensions.
- [ ] Reuse authenticated state without unsafe profile sharing.

## Session Lifecycle

- [ ] Start browser lazily on first adviser use.
- [ ] Reuse the runtime when healthy.
- [ ] Recover from browser crash.
- [ ] Recover from stale tabs.
- [ ] Shut down cleanly on Pi/session termination when appropriate.
- [ ] Preserve authenticated profile across restarts.
- [ ] Separate persistent auth state from ephemeral task state.

## DOM/Interaction Robustness

- [ ] Prefer semantic DOM operations over coordinates/screenshots.
- [ ] Detect ChatGPT generation-in-progress reliably.
- [ ] Detect completed assistant turn.
- [ ] Detect visible provider errors.
- [ ] Detect login/challenge pages.
- [ ] Handle ChatGPT UI changes with localized adapters.
- [ ] Avoid long single blocking browser waits.
- [ ] Implement bounded polling/backoff.
- [ ] Save sufficient diagnostics without recording credentials.

## Model Selection

- [ ] Implement `auto-best` default.
- [ ] Permit explicit configured adviser model/preset.
- [ ] Detect when configured model is unavailable.
- [ ] Fall back safely or report capability mismatch.
- [ ] Never silently use a clearly weaker/free model when the request specifically requires the configured adviser capability.

## Exit Criteria

- [ ] Extension can reliably open ChatGPT, select adviser capability, submit a small test prompt, and collect the response using the isolated profile.

---

# M4 — ChatGPT Project and Conversation Management

## Repository → Project Mapping

- [ ] Define stable repository identity key.
- [ ] Detect whether a ChatGPT Project mapping already exists.
- [ ] Create one ChatGPT Project per GitHub repository when needed.
- [ ] Persist Project identifier/URL locally.
- [ ] Reuse existing mapping across Pi sessions.
- [ ] Recover if the Project is renamed.
- [ ] Recover if the Project is deleted.
- [ ] Avoid creating duplicate Projects during concurrent setup.

## Project Instructions

- [ ] Define concise Project instructions.
- [ ] State that the Project is bound to one GitHub repository.
- [ ] State that Pi executes and ChatGPT advises.
- [ ] State that requested commit SHA is authoritative.
- [ ] State that ChatGPT should inspect GitHub directly.
- [ ] State that ChatGPT should not ask Pi to paste repository files.
- [ ] State that Project memory is lower priority than current checkpoint code.
- [ ] Avoid embedding ephemeral branch/commit values in Project instructions.

## Task Conversation Mapping

- [ ] Define task/session identity.
- [ ] Create one adviser conversation per task.
- [ ] Persist conversation ID/URL.
- [ ] Reuse same conversation for follow-ups.
- [ ] Start a new conversation for unrelated tasks.
- [ ] Prevent concurrent writes to the same conversation.
- [ ] Permit concurrent consultations in different task conversations.

## Recovery

- [ ] Detect deleted/stale conversation.
- [ ] Start a replacement conversation in the same Project.
- [ ] Send a concise task handoff if continuity matters.
- [ ] Never treat Project memory as a substitute for exact checkpoint provenance.

## Exit Criteria

- [ ] One repository consistently maps to one ChatGPT Project and multiple task-specific conversations can coexist safely.

---

# M5 — Consultation Job Engine

## Job Model

- [ ] Define consultation job state machine.
- [ ] Support queued, running, completed, failed, cancelled.
- [ ] Support synchronous and asynchronous modes.
- [ ] Support `dependency: advisory | required`.
- [ ] Allocate stable consultation IDs such as `adv-...`.
- [ ] Persist state before browser submission.
- [ ] Persist result before wake-up delivery.

## Suggested Job Record

- [ ] repository identity;
- [ ] branch;
- [ ] requested ref;
- [ ] resolved SHA;
- [ ] HEAD at dispatch;
- [ ] optional PR;
- [ ] request type;
- [ ] dependency type;
- [ ] ChatGPT Project ID;
- [ ] conversation ID;
- [ ] timestamps;
- [ ] result status;
- [ ] HEAD at receipt;
- [ ] response path;
- [ ] parsed action items.

## Synchronous Execution

- [ ] Submit and await adviser response.
- [ ] Bound wait behavior.
- [ ] Allow cancellation.
- [ ] Surface provider/auth errors cleanly.
- [ ] Preserve durable result if user interrupts UI delivery.

## Asynchronous Execution

- [ ] Dispatch without blocking the worker.
- [ ] Persist detached/background job state safely.
- [ ] Continue Pi work.
- [ ] Detect completion.
- [ ] Best-effort wake-up matching the correct Pi session/task.
- [ ] Preserve result even if wake-up is missed.
- [ ] Add `/advisor-status` and `/advisor-read`.

## Concurrency

- [ ] Configure a conservative default maximum number of concurrent ChatGPT jobs.
- [ ] Serialize operations within the same ChatGPT conversation.
- [ ] Permit parallel conversations when safe.
- [ ] Prevent Project-creation races.
- [ ] Prevent auth-maintenance races.
- [ ] Prevent duplicate job dispatch after retries/restarts.

## Exit Criteria

- [ ] At least two independent task consultations can run safely without cross-delivery or conversation contamination.

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
