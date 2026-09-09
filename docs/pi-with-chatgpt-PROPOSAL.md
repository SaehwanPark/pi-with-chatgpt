# pi-with-chatgpt — Project Proposal

> **Working title:** `pi-with-chatgpt`  
> **Core principle:** **ChatGPT advises. Pi decides and executes.**  
> **Status:** Proposed architecture for implementation  
> **Primary V1 context transport:** GitHub only

## 1. Executive Summary

`pi-with-chatgpt` is a Pi extension that lets a comparatively inexpensive or local Pi worker model consult a stronger ChatGPT model as an external senior adviser, reviewer, auditor, or intelligence oracle.

The intended relationship is deliberately asymmetric:

- **Pi owns execution.**
  - edits files
  - runs shell commands
  - runs tests
  - manages git
  - creates commits and pushes them
  - decides whether and how to act on advice
- **ChatGPT owns advisory reasoning.**
  - architecture and design review
  - implementation planning
  - code review
  - failure-mode and security audits
  - debugging strategy
  - adversarial challenge
  - second opinions

ChatGPT does **not** orchestrate Pi and does **not** receive local write or execution capabilities.

The shared source-of-truth between the two sides is **GitHub**. Pi commits and pushes an appropriate checkpoint. ChatGPT then inspects that exact remote repository state through its own GitHub connector. Repository archives, custom workspace MCP bridges, file uploads, and tunnel infrastructure are intentionally excluded from V1.

Every consultation is anchored to an immutable git commit SHA. This allows the Pi development cursor and the ChatGPT advice cursor to diverge safely: Pi may continue working while ChatGPT reviews an earlier checkpoint, and the extension can later assess how far the code has drifted from the state on which the advice was based.

The result is a loosely coupled engineering-adviser architecture that is especially attractive when Pi runs inexpensive cloud models or local models while a high-capability ChatGPT subscription remains available for selected high-value reasoning tasks.

---

## 2. Motivation

Modern coding-agent workflows frequently have an asymmetric resource profile:

- inexpensive or local models are capable enough for a large fraction of implementation work;
- expensive frontier reasoning is most valuable at specific decision points;
- the strongest model need not control the full coding loop to add substantial value;
- users may already pay for a high-limit ChatGPT subscription whose reasoning capacity is underused during local agentic development.

A common but inefficient architecture is to make the strongest model the primary coding agent for every task. Another is to package and upload large repository snapshots whenever a second opinion is needed.

`pi-with-chatgpt` instead uses a **consulting model**:

```text
                 ┌─────────────────────────┐
                 │        ChatGPT          │
                 │                         │
                 │  plan / review / audit  │
                 │  design / debug / ideas │
                 └────────────┬────────────┘
                              │
                       GitHub connector
                         read-only
                              │
                              ▼
                   ┌────────────────────┐
                   │       GitHub       │
                   │                    │
                   │ commit / PR / code │
                   │ history / docs     │
                   └──────────▲─────────┘
                              │
                        commit + push
                              │
                  ┌───────────┴───────────┐
                  │          Pi           │
                  │                       │
                  │ inexpensive/local LLM │
                  │ edit / shell / tests  │
                  │ git / implementation  │
                  └───────────────────────┘
```

GitHub becomes the shared blackboard and git becomes the synchronization protocol.

---

## 3. Goals

### 3.1 Primary Goals

1. Allow Pi to consult ChatGPT for high-value reasoning without making ChatGPT the active orchestrator.
2. Let ChatGPT inspect repository state independently through its own GitHub connector.
3. Anchor every consultation to an immutable git commit checkpoint.
4. Permit the Pi development cursor to advance while advice is pending.
5. Detect and explain drift between the advice checkpoint and current development state.
6. Support both synchronous and asynchronous consultations.
7. Reuse an existing paid ChatGPT account with minimal authentication friction.
8. Keep normal user browser activity isolated from adviser automation.
9. Persist consultation provenance and advice outside the model context.
10. Degrade gracefully when the adviser is unavailable.

### 3.2 Secondary Goals

- Make adviser consultation ergonomic enough for normal agentic development.
- Support both explicit user requests and conservative agent-initiated consultations.
- Enable task-specific follow-up conversations.
- Organize ChatGPT state around one ChatGPT Project per GitHub repository.
- Preserve compatibility with local-worker workflows and Pi subagent/team extensions.
- Keep V1 small enough to harden thoroughly.

---

## 4. Non-Goals for V1

V1 intentionally does **not** attempt to provide:

- a custom workspace MCP bridge;
- local filesystem access from ChatGPT;
- Cloudflare or other public tunnels;
- repository archive creation or upload;
- arbitrary file uploads to ChatGPT;
- log or diagnostic attachment uploads;
- direct ChatGPT write access to GitHub;
- direct ChatGPT write access to the local workspace;
- shell execution by ChatGPT;
- a ChatGPT-driven PLAN → EXECUTE → REVIEW state machine;
- automatic execution of adviser recommendations;
- perfect real-time synchronization between Pi and ChatGPT;
- support for non-GitHub repository hosts;
- Grok or other adviser providers;
- mandatory PR creation for every consultation.

The V1 rule is intentionally strict:

> **Source code and repository context reach ChatGPT only through GitHub.**

---

## 5. Core Design Principles

### 5.1 ChatGPT Advises; Pi Decides and Executes

ChatGPT output is advisory input, not authority.

Pi remains responsible for:

- evaluating recommendations;
- reconciling them with current code;
- rejecting stale or unsuitable suggestions;
- implementing accepted changes;
- testing;
- committing;
- pushing;
- user escalation when required by the surrounding workflow.

### 5.2 Git Is the Temporal Coordinate System

The fundamental unit of adviser provenance is an immutable commit SHA.

Instead of:

> “ChatGPT reviewed the current code.”

the system records:

> “ChatGPT reviewed repository state `abc123...`.”

### 5.3 Development and Advice Cursors May Diverge

The architecture explicitly supports:

```text
A ── B ── C ── D ── E
     ▲              ▲
     │              │
  adviser        current Pi
 checkpoint       cursor
```

Advice remains anchored to `B`; Pi determines its applicability at `E`.

### 5.4 The Worker Sends a Brief, Not a Repository Summary

Pi should provide information GitHub cannot supply efficiently:

- goal;
- decision under consideration;
- concern;
- alternatives;
- requested review mode;
- exact repository/ref/PR identifiers.

Pi should **not** summarize the entire codebase for ChatGPT.

### 5.5 Independent Inspection Is Preferred

ChatGPT should inspect the repository, PR, history, tests, and relevant surrounding files itself through GitHub rather than trusting Pi's claims about what the code contains.

### 5.6 Advice Must Be Auditable

Every consultation should preserve:

- repository identity;
- requested ref;
- resolved immutable commit;
- branch;
- optional PR;
- dispatch time;
- receipt time;
- ChatGPT conversation;
- response;
- action items;
- advice disposition when available.

### 5.7 Adviser Failure Should Usually Not Block Development

Consultations default to **advisory** rather than **required**.

If ChatGPT authentication expires, quota is exhausted, the GitHub connector is unavailable, or a background request fails, Pi should normally continue local work.

---

## 6. High-Level Architecture

```text
┌───────────────────────────────────────────────────────────────────┐
│                              Pi                                   │
│                                                                   │
│  worker model ── adviser extension ── git checkpoint validation    │
│      │                  │                     │                    │
│      │                  │                     └── push / PR state  │
│      │                  │                                          │
│      │                  ├── consultation ledger                    │
│      │                  ├── drift evaluator                        │
│      │                  ├── ChatGPT job manager                    │
│      │                  └── auth/session manager                   │
│      │                                                             │
│      └── edit / shell / tests / git                                │
└───────────────────────┬───────────────────────────────────────────┘
                        │
                        │ git push
                        ▼
                 ┌──────────────┐
                 │    GitHub    │
                 └──────▲───────┘
                        │
                        │ ChatGPT GitHub connector
                        │
                ┌───────┴────────┐
                │    ChatGPT     │
                │   adviser      │
                └────────────────┘
```

### 6.1 Major Components

#### Pi Extension Layer

Responsible for:

- slash commands;
- agent-facing adviser tools;
- repository/ref resolution;
- checkpoint validation;
- push-state validation;
- consultation dispatch;
- durable job state;
- result retrieval;
- wake-up integration;
- drift analysis;
- advice disposition;
- TUI status.

#### ChatGPT Runtime Layer

Responsible for:

- isolated browser profile;
- ChatGPT authentication;
- model/mode selection;
- ChatGPT Project discovery/creation;
- task-specific conversation creation;
- prompt submission;
- response collection;
- same-thread follow-up.

#### Adviser Ledger

Responsible for durable local provenance independent of Pi context history.

#### GitHub

Acts as:

- canonical remote code source;
- immutable checkpoint store;
- PR/diff context;
- history and documentation source;
- shared information substrate between Pi and ChatGPT.

---

## 7. Repository and ChatGPT Project Mapping

### Decision

**One ChatGPT Project per GitHub repository.**

Within that Project:

- each distinct Pi task/session receives its own adviser conversation;
- follow-ups for the same task continue the same conversation;
- new unrelated tasks start new conversations.

Conceptually:

```text
GitHub repository
  └── ChatGPT Project
        ├── task conversation A
        ├── task conversation B
        └── task conversation C
```

### Benefits

- repository-specific organization;
- durable repository identity;
- project-level architectural memory;
- less cross-repository contamination;
- task-level conversational isolation;
- reusable GitHub connector context.

### Trust Ordering

When information conflicts:

1. current GitHub code at the explicitly requested commit;
2. current consultation brief;
3. current task conversation history;
4. ChatGPT Project instructions;
5. ChatGPT Project memory.

GitHub state at the requested commit is authoritative.

---

## 8. Git Checkpoint Protocol

### 8.1 Required Consultation Identity

Every consultation must resolve:

```yaml
consultation_id: adv-...
repo: owner/name
branch: feat/example
requested_ref: HEAD
resolved_commit: <full SHA>
pr: 42 # optional
```

`requested_ref` may be human-friendly and mutable.

`resolved_commit` must always be immutable.

### 8.2 Remote Availability Requirement

Before ChatGPT is asked to inspect a checkpoint, the extension must verify that the target commit is reachable from the relevant GitHub remote.

A consultation must not silently publish arbitrary local state.

If the desired checkpoint is not remotely available:

- Pi may prepare and push a normal checkpoint only when existing workflow permissions already authorize doing so;
- otherwise the consultation should stop with a concise actionable explanation.

### 8.3 Advice Cursor vs Development Cursor

Persist at least:

```ts
interface ConsultationRefState {
  requestedRef: string
  resolvedCommit: string
  headAtDispatch: string
  headAtReceipt?: string
}
```

This supports a precise answer to:

- what did ChatGPT review?
- where was Pi when it asked?
- where is Pi now?
- how much relevant code changed meanwhile?

### 8.4 Force-Push Policy

Active advice records should continue to reference immutable commit SHAs even if a branch later moves.

The extension should avoid relying on branch reachability after dispatch.

If the referenced object is no longer available remotely, mark provenance as degraded rather than silently retargeting the advice.

---

## 9. Consultation Modes

V1 should support several semantic request types.

### `consult`

Open-ended senior advice.

Use for:

- tradeoffs;
- design choices;
- second opinions;
- “what am I missing?” questions.

### `plan`

Ask ChatGPT to inspect the checkpoint and recommend an implementation plan.

### `review`

Review a specific implementation checkpoint, branch delta, or PR.

### `audit`

Perform a broader adversarial inspection.

Examples:

- concurrency;
- security;
- recovery;
- data loss;
- portability;
- API misuse;
- failure modes.

### `debug`

Ask for root-cause analysis and debugging strategy based on repository state.

Because V1 is GitHub-only, debugging requests must rely on repository-visible evidence.

### `challenge`

Ask ChatGPT to actively try to invalidate a proposed design or assumption.

This is especially useful before expensive implementation work.

---

## 10. Consultation Trigger Policy

### 10.1 Explicit Requests

Explicit user requests always take precedence.

Example:

```text
/advisor audit "Look for race conditions and recovery failures."
```

### 10.2 Agent-Initiated Requests

Pi may initiate advice conservatively when additional intelligence has high marginal value.

Recommended trigger classes:

- major architecture fork;
- subtle concurrency or ownership issue;
- security-sensitive design;
- data-loss/recovery risk;
- repeated failed implementation attempts;
- large cross-cutting refactor;
- unfamiliar subsystem with high consequences;
- explicit independent review before release.

Ordinary edits should remain local.

Examples that normally should **not** trigger adviser calls:

- typo fixes;
- formatting;
- straightforward unit-test additions;
- small mechanical refactors;
- trivial bugs;
- obvious dependency updates.

### 10.3 No Simple “N Failures” Rule

Repeated failure may be one useful signal, but auto-consultation should not depend solely on a numeric threshold.

The semantic cost/benefit of stronger reasoning matters more than line count or retry count.

---

## 11. Synchronous and Asynchronous Consultation

### 11.1 Synchronous

Use when Pi cannot reasonably proceed without the answer.

Example:

> Choose between two incompatible persistence architectures.

Pi waits for the adviser response.

### 11.2 Asynchronous

Use when Pi can continue independent work.

Example:

> Audit the current checkpoint for architectural failure modes while Pi improves documentation.

The consultation is dispatched, persisted, and later surfaced to the matching Pi session.

### 11.3 Dependency Flag

Every consultation should carry:

```yaml
dependency: advisory | required
```

Default:

```yaml
dependency: advisory
```

Failure of an advisory request does not block Pi.

---

## 12. Request Format

The worker should provide a concise decision brief rather than a repository dump.

Recommended conceptual request:

```text
CONSULTATION: adv-014
TYPE: audit
REPOSITORY: owner/repo
BRANCH: feat/ownership
CHECKPOINT: <full SHA>
PR: #42

GOAL:
Prevent concurrent subagents from modifying the same resource unsafely.

CURRENT APPROACH:
Ownership is currently resource-scoped.

CONCERN:
Caller/child interactions may permit cyclic waiting.

QUESTION:
Audit this design and implementation for deadlocks, race conditions,
and cancellation/recovery failures.

INSTRUCTION:
Inspect the repository yourself through GitHub. Treat CHECKPOINT as
the authoritative repository state. Do not implement anything.
Provide reasoning and actionable recommendations.
```

Pi should not send an extensive summary of files that ChatGPT can inspect itself.

---

## 13. Response Contract

Pure JSON is too restrictive for high-quality advisory reasoning.

Free-form prose is too difficult for smaller worker models to consume reliably.

Use a hybrid structure.

Example:

```text
ADVISOR
consultation: adv-014
reviewed_commit: <full SHA>
status: actionable

ASSESSMENT
...

RECOMMENDATION
...

ACTION ITEMS
A1. ...
A2. ...
A3. ...

RISKS
...

OPTIONAL IDEAS
...
```

### Stable Action IDs

Action items should receive stable IDs where practical:

```text
A1
A2
A3
```

This permits later disposition tracking and follow-up.

The extension should preserve the raw response even if structured parsing is partial.

---

## 14. Advice Disposition

Pi must not blindly execute adviser recommendations.

Each action item may later receive a disposition:

```text
accepted
implemented
partially_implemented
rejected_with_reason
superseded
stale
needs_reconsultation
```

Example:

```text
A1 implemented
A2 rejected — conflicts with required backward compatibility
A3 superseded by the new lifecycle design
```

A follow-up consultation can ask ChatGPT to review how its recommendations were handled.

---

## 15. Drift and Staleness Handling

When advice arrives, compare its checkpoint with current Pi HEAD.

### 15.1 Basic Graph Cases

```text
checkpoint == current
  → current

checkpoint is ancestor of current
  → stale but potentially applicable

checkpoint and current diverged
  → strong revalidation signal

checkpoint object unavailable remotely
  → degraded provenance
```

### 15.2 Relevant Drift

The extension should inspect changes since the adviser checkpoint.

Especially important:

- files named in recommendations;
- directly related components;
- interfaces;
- tests;
- config;
- dependency changes.

Example user-facing status:

```text
Adviser reviewed 8f731e2.
Current HEAD is da5c991, 3 commits ahead.

Relevant drift:
- src/runtime/ownership.ts changed
- tests/ownership.test.ts changed

Recommendations A2 and A4 may need revalidation.
```

### 15.3 Reconsultation Policy

Do not reconsult merely because HEAD advanced.

Reconsult when:

- affected implementation areas changed materially;
- assumptions in the advice no longer hold;
- branch history diverged;
- Pi explicitly requests revalidation;
- high-risk recommendations remain unresolved.

---

## 16. Authentication Architecture

Authentication is intentionally layered.

### 16.1 OpenAI Identity Layer

Preferred source:

- Pi's existing `openai-codex` OAuth credential.

Use it for:

- OpenAI account identity;
- account/workspace matching;
- plan/entitlement hints;
- avoiding redundant identity login;
- consistency checks.

Do **not** assume that Codex OAuth tokens are directly usable as ChatGPT Web browser sessions.

### 16.2 ChatGPT Web Session Layer

Actual ChatGPT adviser operation uses a dedicated isolated browser profile.

Example state location:

```text
~/.pi/agent/pi-with-chatgpt/
  browser/
    chatgpt-profile/
```

### 16.3 Authentication Resolution Order

Preferred conceptual order:

1. existing isolated ChatGPT adviser profile;
2. Pi OpenAI/Codex OAuth identity;
3. optional Codex CLI identity source if useful;
4. explicit import from an existing Chrome/Chromium ChatGPT session;
5. one-time manual login inside the isolated adviser browser.

### 16.4 Browser Session Import

Import should be:

- explicit;
- one-time or repair-oriented;
- source profile read-only;
- isolated from normal browser automation;
- credential-safe;
- followed by adviser-profile verification.

### 16.5 Account Matching

Where possible, compare:

- expected OpenAI account from Pi OAuth;
- account active in the imported/isolated ChatGPT browser session.

If they disagree, do not silently continue.

### 16.6 Capability Detection

Do not rely only on plan labels.

Verify adviser capabilities such as:

- ChatGPT authenticated;
- desired strong model available;
- GitHub connector available;
- repository accessible.

---

## 17. Browser and Runtime Isolation

Normal adviser jobs must not automate the user's active Chrome session.

Use a dedicated extension-managed browser runtime/profile.

Benefits:

- no focus stealing;
- no mutation of active browsing state;
- fewer conflicts with other Pi browser extensions;
- predictable persistence;
- easier authentication recovery;
- clearer security boundary.

The browser runtime is an implementation mechanism, not part of the Pi worker's cognitive loop.

The worker should call adviser tools rather than manually operating ChatGPT UI elements.

---

## 18. Durable Adviser Ledger

Default persistence should be local rather than repository-visible.

Suggested location:

```text
~/.pi/agent/pi-with-chatgpt/
  repositories/
    <repo-id>/
      consultations.jsonl
      responses/
      tasks/
```

Suggested consultation record:

```json
{
  "id": "adv-014",
  "repo": "owner/repo",
  "branch": "feat/ownership",
  "requestedRef": "HEAD",
  "resolvedCommit": "8f731e2...",
  "headAtDispatch": "8f731e2...",
  "headAtReceipt": "da5c991...",
  "pr": 42,
  "kind": "audit",
  "dependency": "advisory",
  "conversationId": "...",
  "projectId": "...",
  "status": "complete"
}
```

Advice should not automatically become:

- a repository file;
- an issue;
- a PR comment;
- permanent team-visible history.

Publishing selected advice may be considered after V1.

---

## 19. Commands and Agent-Facing Tools

Exact naming may change, but a minimal user-facing surface could include:

```text
/advisor <request>
/advisor-plan <request>
/advisor-review [request]
/advisor-audit <request>
/advisor-debug <request>
/advisor-challenge <request>
/advisor-followup <consultation-id> <request>
/advisor-status [consultation-id]
/advisor-read [consultation-id]
/advisor-auth
```

Agent-facing tools should expose structured primitives such as:

```text
advisor_preflight
advisor_submit
advisor_read
advisor_status
advisor_followup
advisor_auth
advisor_cancel
advisor_disposition
```

The worker should not need to understand browser automation details.

---

## 20. Checkpoint UX

The extension should resolve and display:

```text
Repository: owner/repo
Branch: feat/foo
Checkpoint: abc123...
PR: #42
Remote: origin
```

### Existing Remote Checkpoint

If the current intended checkpoint is already remote:

- proceed without extra friction.

### Local Commit Not Yet Pushed

If workflow permissions already authorize pushing:

- push normally;
- verify remote reachability;
- dispatch.

Otherwise:

- request the minimum necessary user action/approval.

### Uncommitted State

Consultation itself must not imply permission to:

```text
git add -A
git commit
git push
```

Pi may prepare a checkpoint only under the same rules that govern ordinary development.

---

## 21. GitHub-Only V1 Boundary

V1 deliberately refuses to create a second source-code transport.

Therefore:

### Supported

- repository code on GitHub;
- commit history;
- branches;
- PRs;
- repository documentation;
- repository-visible tests/configuration;
- issues when relevant and available through the connected GitHub surface.

### Not Supported

- uncommitted local code;
- local-only logs;
- local benchmark output;
- local screenshots;
- transient compiler output;
- arbitrary attachments;
- repository archives.

If important evidence is local-only, Pi should either:

- reason locally;
- commit an appropriate reproducible artifact when that is normal and safe;
- or continue without adviser input.

A richer evidence channel may be considered after V1.

---

## 22. Concurrency Model

Multiple Pi tasks or subagents may request adviser consultations concurrently.

Preferred model:

- one ChatGPT Project per repo;
- separate task conversations;
- separate durable consultation jobs;
- independent result delivery.

Do not serialize unrelated consultations through one giant ChatGPT thread.

Conversation-level locking may still be needed to prevent concurrent writes to the **same** task conversation.

The design should be compatible with multi-agent Pi environments, including extensions that coordinate subagents.

---

## 23. Failure and Recovery Model

Expected failures include:

- ChatGPT auth expiry;
- CAPTCHA/2FA;
- adviser model unavailable;
- subscription quota exhaustion;
- GitHub connector unavailable;
- repository access missing;
- requested commit not pushed;
- browser crash;
- stale/deleted ChatGPT conversation;
- ChatGPT Project missing or renamed;
- response timeout;
- Pi session ending before background response delivery.

### Principles

1. durable job state first;
2. best-effort wake-up second;
3. advisory failures should not normally block Pi;
4. never silently retarget a consultation to a different commit;
5. never silently switch OpenAI accounts;
6. preserve enough state for explicit recovery.

---

## 24. Security and Privacy

### 24.1 No Local Repository Upload in V1

Code reaches ChatGPT only through the repository access that the user already granted through GitHub.

### 24.2 Browser Credentials

ChatGPT browser state is sensitive authentication material.

Requirements:

- restricted local permissions;
- no credential logging;
- no plaintext cookie export as routine state;
- no browser-session values exposed to the worker model;
- no active-browser automation for normal adviser jobs.

### 24.3 OpenAI OAuth Credentials

Reuse Pi's supported credential abstraction when possible.

Do not copy long-lived OAuth credentials into project-local configuration.

### 24.4 Repository Publication Safety

Adviser consultation is not authorization to publish local secrets or unrelated work.

Existing git safety and project trust semantics remain authoritative.

### 24.5 Advice Is Untrusted Input

Even strong-model output can be incorrect.

Pi should treat adviser output as a recommendation subject to:

- current code;
- tests;
- project constraints;
- user instructions;
- independent worker judgment.

---

## 25. Interoperability

The extension should coexist cleanly with:

- different Pi worker providers/models;
- local models;
- Pi subagent/team extensions;
- context-management extensions;
- browser/computer-use extensions;
- MCP extensions;
- GitHub tooling.

### Key Rule

`pi-with-chatgpt` should own **only its dedicated adviser browser runtime**.

It should not:

- hijack a global browser tool;
- mutate another extension's state;
- require the active Pi worker to use OpenAI;
- assume a single-agent Pi session.

---

## 26. Configuration Philosophy

Defaults should work for most users.

Avoid requiring users to tune low-level browser, polling, or timeout values.

Likely user-visible configuration:

```json
{
  "defaults": {
    "autoConsult": "high-value",
    "consultationMode": "async",
    "dependency": "advisory"
  },
  "chatgpt": {
    "model": "auto-best"
  }
}
```

Advanced browser/auth configuration should be global-only and hidden from normal users unless auto-detection fails.

Project-local configuration should be limited to safe behavioral overrides and respect Pi project trust.

---

## 27. V1 Product Experience

A successful normal flow should feel approximately like:

```text
You: Audit this ownership design before we continue.

pi-with-chatgpt:
✓ Repository: owner/repo
✓ Checkpoint: 8f731e2
✓ ChatGPT adviser dispatched

Pi may continue working while the audit runs.
```

Later:

```text
ChatGPT adviser completed the audit of 8f731e2.

Current HEAD: da5c991 (3 commits ahead)
Relevant drift detected in 2 files.

Top recommendations:
A1. ...
A2. ...
A3. ...
```

The user should not need to understand:

- browser profiles;
- OAuth internals;
- cookies;
- ChatGPT DOM automation;
- job directories.

---

## 28. V1 Acceptance Criteria

V1 is successful when all of the following are true:

1. A Pi session using a non-OpenAI worker model can consult a paid ChatGPT adviser.
2. Adviser authentication survives normal restarts.
3. Existing Pi OpenAI/Codex identity is reused where available.
4. ChatGPT runs in an isolated adviser-owned browser profile.
5. A GitHub repository maps to one ChatGPT Project.
6. A task maps to a dedicated adviser conversation within that Project.
7. Every request is anchored to a remotely available immutable commit SHA.
8. ChatGPT independently inspects that repository state through GitHub.
9. Pi can continue working while an asynchronous consultation runs.
10. Advice returns with exact checkpoint provenance.
11. The extension detects and reports checkpoint-to-current drift.
12. Stable action IDs can be tracked through disposition/follow-up.
13. Adviser failure does not normally block local development.
14. No repository archive or local source file is uploaded to ChatGPT by the extension.
15. The extension works with both inexpensive cloud and local Pi worker models.
16. Core flows are tested on the intended supported OSes.
17. Normal use requires minimal configuration.

---

## 29. Future Directions

Post-V1 possibilities include:

- optional sanitized ephemeral diagnostic evidence;
- adviser comparison across multiple models/providers;
- selected advice publication to GitHub PRs/issues;
- richer PR-centered workflows;
- adviser-result synthesis across parallel subagents;
- automatic recommendation disposition inference;
- semantic drift scoring;
- release-gate audit policies;
- organization/team policy support;
- support for GitLab or other repository hosts;
- offline/local senior-model adviser backends;
- optional architecture-decision-record generation;
- cross-repository consultation for multi-repo systems.

These should remain additive. The V1 principle—**GitHub checkpoints as immutable shared state and ChatGPT as adviser rather than orchestrator**—should remain the architectural center.
