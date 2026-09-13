---
layout: default
title: User Guide (Slash Commands)
permalink: /user-guide/
---

# User Guide: Slash Commands

[Home]({{ site.baseurl }}/) | [Getting Started]({{ site.baseurl }}/getting-started/) | [User Guide]({{ site.baseurl }}/user-guide/) | [Agent Tools]({{ site.baseurl }}/agent-tools/) | [Configuration]({{ site.baseurl }}/configuration/) | [Drift]({{ site.baseurl }}/drift-and-disposition/) | [Troubleshooting]({{ site.baseurl }}/troubleshooting/) | [Architecture]({{ site.baseurl }}/architecture-and-safety/)

---

`pi-with-chatgpt` equips Pi with **11 specialized slash commands**. These commands allow you to request senior advisory input, continue task conversations, inspect drift, read advice, and manage authentication directly within your Pi terminal session.

---

## Command Overview

| Command | Category | Purpose | Typical Scenario |
| --- | --- | --- | --- |
| [`/advisor`](#1-advisor-request) | Core Consultation | General senior advisory on the current checkpoint | Broad architectural questions, second opinions |
| [`/advisor-plan`](#2-advisor-plan-request) | Core Consultation | Implementation planning anchored to checkpoint | Multi-step feature rollout, schema migrations |
| [`/advisor-review`](#3-advisor-review-request) | Core Consultation | Code review of current commit, branch delta, or PR | Pre-merge sanity check, quality audit |
| [`/advisor-audit`](#4-advisor-audit-request) | Adversarial | Concurrency, security, and recovery failure-mode audit | Stress-testing lock-free code or auth paths |
| [`/advisor-debug`](#5-advisor-debug-request) | Diagnostic | Root-cause analysis from repository-visible evidence | Tracing elusive race conditions or memory leaks |
| [`/advisor-challenge`](#6-advisor-challenge-request) | Adversarial | Red-team a proposed design and surface trade-offs | Architecture decision records (ADRs) |
| [`/advisor-followup`](#7-advisor-followup-id-request) | Conversation Management | Continue a prior consultation with drift awareness | Refining advice, answering adviser questions |
| [`/advisor-status`](#8-advisor-status-id) | Lifecycle & Drift | Inspect consultation state and dual-cursor drift | Checking if pending advice is ready or stale |
| [`/advisor-read`](#9-advisor-read-id) | Output & Ledger | Expand full advisory response in formatted markdown | Reviewing complete recommendations and code |
| [`/advisor-cancel`](#10-advisor-cancel-id) | Lifecycle & Drift | Cancel an in-flight consultation | Aborting a job after a rapid design pivot |
| [`/advisor-auth`](#11-advisor-auth) | Diagnostics & Auth | Inspect authentication and launch isolated browser | Initial login or refreshing expired sessions |

---

## 1. `/advisor <request>`

Dispatches a general advisory request anchored to the current git checkpoint.

- **Syntax**: `/advisor <request>`
- **When to use**: When you need a general second opinion on codebase structure, API ergonomics, or library selection.
- **Example**:
  ```text
  /advisor What are the architectural implications of moving our pub/sub transport from Redis to NATS JetStream?
  ```
- **Output Sample**:
  ```text
  [advisor:general] dispatching adv-b14e-1 (owner/repo@3510f4a, sync)
  Pi may continue working while the consultation runs.

  ChatGPT Adviser (3510f4a):
  Moving to NATS JetStream introduces strong at-least-once delivery guarantees
  and simplifies multi-tenant subject isolation, but requires refactoring
  consumer acknowledgement logic...
  ```

---

## 2. `/advisor-plan <request>`

Requests a structured implementation plan for a new feature, refactor, or migration.

- **Syntax**: `/advisor-plan <request>`
- **When to use**: Before writing code on a non-trivial feature. The adviser reads the current repository structure on GitHub and provides a phased, step-by-step roadmap.
- **Example**:
  ```text
  /advisor-plan Outline a zero-downtime migration plan for adding foreign key constraints to the billing_ledger table.
  ```
- **Structured Action Items**: The plan is automatically tagged with numbered action items (`A1`, `A2`, `A3`), making it easy for the Pi worker to execute and disposition each step.

---

## 3. `/advisor-review [request]`

Performs an in-depth code review on the current commit, branch changes, or pull request.

- **Syntax**: `/advisor-review [request]`
- **When to use**: After finishing an implementation slice and pushing to GitHub, before opening a PR or merging to `main`.
- **Parameters**:
  - `request` (optional): Specific areas to focus on (e.g. error handling, performance, edge cases). If omitted, performs a general comprehensive review.
- **Example**:
  ```text
  /advisor-review Focus particularly on concurrency boundaries and mutex acquisition order in the job scheduler.
  ```
- **Output Sample**:
  ```text
  [advisor:review] dispatching adv-c902-1 (owner/repo@c3fc194, sync)
  Adviser Code Review completed for commit c3fc194:
  - Strengths: Mutex locking is cleanly scoped with RAII guards.
  - Potential Risk: In `jobs/scheduler.ts#L84`, re-acquiring the lock inside the timeout callback can lead to priority inversion.
  - Action Items:
    [A1] Wrap the timeout handler in an unlocked dispatch block.
    [A2] Add an integration test simulating scheduler starvation.
  ```

---

## 4. `/advisor-audit <request>`

Performs an adversarial, worst-case audit of critical sub-systems.

- **Syntax**: `/advisor-audit <request>`
- **When to use**: For security-sensitive components, cryptography, authorization layers, financial transactions, or distributed coordination.
- **Focus Areas**:
  - Race conditions and lock inversion.
  - Memory or resource exhaustion.
  - Unexpected edge inputs or injection vectors.
  - Crash recovery and unhandled Promise rejections.
- **Example**:
  ```text
  /advisor-audit Audit our browser profile permissions check and token handling for local privilege escalation or symlink vulnerabilities.
  ```

---

## 5. `/advisor-debug <request>`

Conducts an objective root-cause analysis based on repository-visible code, logs, and stack traces.

- **Syntax**: `/advisor-debug <request>`
- **When to use**: When facing an intermittent failure, complex race condition, or subtle bug that local analysis hasn't resolved.
- **Example**:
  ```text
  /advisor-debug Unit test `test/recovery.test.ts` fails intermittently with 'worker-timeout' under high CPU load on CI. Analyze potential timing windows in `jobs/queue.ts`.
  ```

---

## 6. `/advisor-challenge <request>`

Red-teams a proposed design or assumption, uncovering blind spots and trade-offs.

- **Syntax**: `/advisor-challenge <request>`
- **When to use**: When you or the Pi worker have arrived at a candidate design, but want to challenge the architecture before committing to it.
- **Example**:
  ```text
  /advisor-challenge We are considering storing consultation transcripts in SQLite instead of append-only JSONL files. Challenge this decision.
  ```

---

## 7. `/advisor-followup <id> <request>`

Continues an existing consultation within the same ChatGPT task conversation.

- **Syntax**: `/advisor-followup <consultation-id> <request>`
- **When to use**: When the adviser asked a clarifying question, suggested alternatives you want to evaluate, or when you need elaboration on a specific action item.
- **Context Preservation**:
  - Uses the same underlying ChatGPT conversation thread.
  - Automatically calculates graph and file drift between the original consultation checkpoint and your current commit.
  - Informs the adviser of any code changes made since the previous turn!
- **Example**:
  ```text
  /advisor-followup adv-c902-1 Regarding A1, would wrapping the callback in setImmediate be sufficient to avoid starvation?
  ```

---

## 8. `/advisor-status [id]`

Queries the current status, progress, and dual-cursor drift of consultations.

- **Syntax**: `/advisor-status [consultation-id]`
- **When to use**: To check if an asynchronous consultation has finished, view the execution timeline, or check whether past advice is still applicable to your current `HEAD`.
- **Output Details**:
  - Consultation ID, mode (`sync` or `async`), and job status (`running`, `completed`, `failed`).
  - Anchor commit SHA vs current `HEAD` commit SHA.
  - Commit graph distance (number of commits ahead or diverged).
  - List of files modified between anchor and `HEAD`.
  - **Drift Tier**: `current`, `likely_applicable`, `materially_stale`, `needs_reconsultation`, or `provenance_degraded`.

---

## 9. `/advisor-read [id]`

Prints the complete markdown content of a consultation response.

- **Syntax**: `/advisor-read [consultation-id]`
- **When to use**:
  - When an asynchronous consultation completes and you want to view the full response.
  - When revisiting historical advice from the durable ledger.
  - If omitted, `id` defaults to the most recent consultation.

---

## 10. `/advisor-cancel <id>`

Cancels an in-flight consultation without blocking local Pi execution.

- **Syntax**: `/advisor-cancel <consultation-id>`
- **When to use**: If you dispatched a long-running review but realized you need to rewrite the code immediately.
- **Behavior**:
  - Gracefully stops the browser automation worker for that job.
  - Marks the job as `cancelled` in the local ledger.
  - Does not corrupt conversation history or state.

---

## 11. `/advisor-auth`

Inspects Pi credential status separately from the current isolated ChatGPT browser session and launches
interactive authentication if needed. A Pi OAuth credential alone is not reported as an authenticated
ChatGPT session; without a fresh browser probe, readiness is `unverified`.

- **Syntax**: `/advisor-auth`
- **When to use**:
  - Initial setup after installation.
  - Whenever session cookies expire.
  - To solve CAPTCHAs or 2FA verification gates.
- **Security Guarantee**: Operates exclusively within the isolated Playwright profile (`~/.pi/agent/pi-with-chatgpt/browser`), never inspecting or modifying your regular browser.

---

## Pro-Tip: Synchronous vs Asynchronous Workflow

You can set your default preference in configuration or override it per request:

- **Need advice right now?** By default (`defaultMode: "sync"`), Pi pauses and waits up to `syncTimeoutMs` (default 4 minutes) for the adviser's turn to finish.
- **Want to keep hacking?** Configure `"defaultMode": "async"`. Dispatched consultations run in the background. Pi immediately returns to your prompt and shows a session-scoped completion notification when the adviser finishes. The notification does not resume or inject a message into the worker model; use `/advisor-status <id>` or `/advisor-read <id>` to retrieve the result.
