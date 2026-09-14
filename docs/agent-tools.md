---
layout: default
title: Agent Tools Reference
permalink: /agent-tools/
---

# Agent Tools Reference (Worker Interface)

[Home]({{ site.baseurl }}/) | [Getting Started]({{ site.baseurl }}/getting-started/) | [User Guide]({{ site.baseurl }}/user-guide/) | [Agent Tools]({{ site.baseurl }}/agent-tools/) | [Configuration]({{ site.baseurl }}/configuration/) | [Drift]({{ site.baseurl }}/drift-and-disposition/) | [Troubleshooting]({{ site.baseurl }}/troubleshooting/) | [Architecture]({{ site.baseurl }}/architecture-and-safety/)

---

In addition to user-facing slash commands, `pi-with-chatgpt` registers **9 agent-facing tools** into the Pi environment. `advisor_consult` is the preferred high-level entry point for normal autonomous use; the remaining tools are lower-level primitives for preflight, lifecycle, authentication, and disposition workflows.

---

## Tool Summary

| Tool Name | Purpose | Primary Invariants |
| --- | --- | --- |
| [`advisor_consult`](#1-advisor_consult) | High-level synchronous-by-default consultation entry point | INV-01, INV-07, INV-13 |
| [`advisor_preflight`](#2-advisor_preflight) | Verify git anchor, remote reachability, live ChatGPT access/model, GitHub connector, and target repository | INV-03, INV-04, INV-09, INV-10 |
| [`advisor_submit`](#3-advisor_submit) | Submit new consultation and persist to ledger | INV-01, INV-06, INV-13 |
| [`advisor_read`](#4-advisor_read) | Fetch full markdown advice and action items | INV-13, INV-15 |
| [`advisor_status`](#5-advisor_status) | Inspect status, graph drift, and file drift | INV-01, INV-05 |
| [`advisor_followup`](#6-advisor_followup) | Continue conversation thread with prior context | INV-01, INV-09 |
| [`advisor_cancel`](#7-advisor_cancel) | Abort in-flight consultation safely | INV-07 |
| [`advisor_auth`](#8-advisor_auth) | Safe non-leaking credential & profile status | INV-11, INV-12 |
| [`advisor_disposition`](#9-advisor_disposition) | Record worker disposition with mandatory rationale | INV-01, INV-15 |

---

## 1. `advisor_consult`

The preferred worker-facing entry point for a normal adviser consultation. It orchestrates checkpoint resolution, trusted-project and session checks, live authentication/capability verification, durable submission, completion/provenance validation, and the worker-facing result. Workers do not need to call `advisor_preflight` first.

### Schema
- **Parameters**:
  - `kind` *(string, required)*: `consult`, `plan`, `review`, `audit`, `debug`, or `challenge`.
  - `goal` *(string, required)*: The question or decision to send to the adviser.
  - `mode` *(string, optional)*: `sync` (default) or explicit `async`.
  - `taskId` *(string, optional)*: Logical task label; it is namespaced by the Pi session.
- **Returns**: A synchronous call returns a compact worker-facing advisory with checkpoint, result status, advice, and actionable items. An asynchronous call returns a consultation ID and queued state; use `advisor_status` and `advisor_read` for the durable result.

### Routing policy
Use this tool when the user or trusted project instructions explicitly ask for ChatGPT/adviser help, a plan, review, audit, debugging help, or a second opinion. Do not use it when the user explicitly says not to use external advisers. `agentUse.mode` controls whether autonomous calls are allowed (`off`, `explicit`, or `proactive`); the extension does not regex-classify user prompts.

### Completion integrity
The adviser response must match the anchored full SHA and end with `consultation_complete: <consultation-id>`. Missing or malformed completion proof produces an `incomplete` or `provenance-ambiguous` result, retains only safe diagnostic evidence, and exposes no actionable items.

---

## 2. `advisor_preflight`

Performs a read-only preflight verification of the current git checkpoint and confirms that the commit is reachable on the configured GitHub remote. It then runs the live, fail-closed capability gate: ChatGPT access, the selected adviser model, the exact GitHub connector repository/checkpoint, and target repository availability. The result is dispatchable only when all four capability checks pass and the browser account identity is verified.

### Schema
- **Parameters**:
  - `cwd` *(string, optional)*: Working directory. Defaults to the current repository directory.
- **Returns**:
  ```json
  {
    "content": [{ "type": "text", "text": "Preflight verification for owner/repo at 3510f4a: ready=true" }],
    "details": {
      "ready": true,
      "repository": "owner/repo",
      "checkpointCommit": "3510f4a8e29bc12d098e72c81a5e182379bc0192",
      "remoteAvailability": "present",
      "capability": {
        "checklist": {
          "results": [
            { "item": "chatgpt-access", "outcome": "verified" },
            { "item": "adviser-model", "outcome": "verified" },
            { "item": "github-connector", "outcome": "verified" },
            { "item": "target-repository", "outcome": "verified" }
          ]
        },
        "modelId": "gpt-5.5",
        "degraded": false
      },
      "readiness": {
        "ready": true,
        "clean": true,
        "pushed": true
      }
    }
  }
  ```

### When to Call
Call `advisor_preflight` before committing large changes or dispatching a consultation to ensure that the commit has been pushed to GitHub. If `ready: false`, the tool returns an explicit refusal stage and reason. A capability failure uses `reason: "capability"` and includes a safe explanation; no consultation is submitted until the missing live prerequisite is repaired.

---

## 3. `advisor_submit`

Submits a new consultation to the senior adviser, anchoring it to the verified commit SHA and logging the request into the local ledger. Prefer `advisor_consult` unless a low-level submission primitive is specifically needed.

### Schema
- **Parameters**:
  - `kind` *(string, required)*: Consultation kind. Allowed values:
    - `"consult"`: General guidance.
    - `"plan"`: Implementation roadmap.
    - `"review"`: Code review of current commit or PR delta.
    - `"audit"`: Adversarial security, concurrency, or recovery audit.
    - `"debug"`: Root-cause diagnosis.
    - `"challenge"`: Architecture red-teaming.
  - `goal` *(string, required)*: Specific question or goal for the consultation.
  - `cwd` *(string, optional)*: Working directory.
  - `taskId` *(string, optional)*: Logical scoping label for conversation isolation. It is namespaced by
    a SHA-256 digest of the current Pi session; the raw session ID is used only for delivery routing and
    is never persisted.
- **Returns**:
  ```json
  {
    "content": [{ "type": "text", "text": "Consultation adv-c902-1 (review) submitted and recorded at c3fc194." }],
    "details": {
      "ok": true,
      "consultationId": "adv-c902-1",
      "advisory": {
        "consultationId": "adv-c902-1",
        "kind": "review",
        "state": "completed",
        "advice": "# Senior Code Review\n\n...",
        "actionItems": [
          { "id": "A1", "summary": "Wrap timeout in unlocked dispatch", "disposition": "pending" }
        ]
      }
    }
  }
  ```

---

## 4. `advisor_read`

Reads the complete markdown advice, action items, and metadata for a previously recorded consultation. If the result status is `incomplete` or `provenance-ambiguous`, the tool explicitly marks the response unusable and returns no actionable action items.

### Schema
- **Parameters**:
  - `consultationId` *(string, required)*: The consultation identifier (e.g. `"adv-c902-1"`).
  - `cwd` *(string, optional)*: Working directory.
- **Returns**:
  ```json
  {
    "content": [{ "type": "text", "text": "Advisory for review (adv-c902-1):\n\n# Code Review..." }],
    "details": {
      "ok": true,
      "consultationId": "adv-c902-1",
      "kind": "review",
      "advisory": {
        "consultationId": "adv-c902-1",
        "advice": "...",
        "actionItems": [...]
      }
    }
  }
  ```

---

## 5. `advisor_status`

Inspects consultation progress and calculates **graph and file drift** between the reviewed commit and current `HEAD`. Live jobs may be `queued` or `running`; terminal results also expose completion validity such as `complete`, `degraded`, `incomplete`, or `provenance-ambiguous`.

### Schema
- **Parameters**:
  - `consultationId` *(string, optional)*: Specific consultation ID. If omitted, returns recent consultations.
  - `cwd` *(string, optional)*: Working directory.
- **Returns**:
  ```json
  {
    "content": [{ "type": "text", "text": "Consultation adv-c902-1: kind=review status=completed drift=likely_applicable" }],
    "details": {
      "ok": true,
      "consultationId": "adv-c902-1",
      "kind": "review",
      "status": "completed",
      "checkpointCommit": "c3fc194...",
      "currentHead": "82a901d...",
      "drift": {
        "classification": "likely_applicable",
        "verdict": "ahead",
        "currency": "fresh",
        "summaryNote": "HEAD is 2 commits ahead of checkpoint, no mentioned files modified.",
        "affectedActionItemIds": []
      }
    }
  }
  ```

---

## 6. `advisor_followup`

Sends a follow-up query to ChatGPT within the existing task conversation, carrying forward prior advice, previous action items, and latest drift information.

### Schema
- **Parameters**:
  - `consultationId` *(string, required)*: ID of the prior consultation to continue.
  - `request` *(string, required)*: Follow-up question, clarification, or proposed amendment.
  - `cwd` *(string, optional)*: Working directory.
- **Returns**:
  ```json
  {
    "content": [{ "type": "text", "text": "Follow-up adv-f110-2 completed for adv-c902-1." }],
    "details": {
      "ok": true,
      "consultationId": "adv-f110-2",
      "response": "Wrapping with setImmediate avoids starvation because..."
    }
  }
  ```

---

## 7. `advisor_cancel`

Gracefully terminates an in-flight consultation.

### Schema
- **Parameters**:
  - `consultationId` *(string, required)*: ID of the consultation to cancel.
  - `cwd` *(string, optional)*: Working directory.
- **Returns**:
  ```json
  {
    "content": [{ "type": "text", "text": "Consultation adv-c902-1 cancelled." }],
    "details": { "ok": true, "cancelled": "adv-c902-1" }
  }
  ```

---

## 8. `advisor_auth`

Inspects OpenAI authentication and Playwright browser profile health without exposing secret tokens or private cookies.

### Schema
- **Parameters**: None.
- **Returns**:
  ```json
  {
    "content": [{ "type": "text", "text": "Adviser authentication: authenticated=unknown" }],
    "details": {
      "authenticated": "unknown",
      "browserSession": { "state": "unverified", "reason": "probe-required" },
      "piOpenAiSignInPresent": true,
      "plan": "ChatGPT Plus",
      "emailMasked": "d***@example.com",
      "accountIdPrefix": "org-9f8",
      "profileExists": true
    }
  }
  ```

---

## 9. `advisor_disposition`

Records the worker or user's decision on a specific action item (`A1`, `A2`, etc.).

> [!IMPORTANT]
> **Mandatory Rationale Requirement (INV-15)**: If the disposition is `rejected_with_reason` or `superseded`, a non-empty `reason` string **must** be provided. Rejections without explicit rationale are rejected by the ledger.

### Schema
- **Parameters**:
  - `consultationId` *(string, required)*: ID of the consultation.
  - `actionItemId` *(string, required)*: Action item identifier (e.g. `"A1"`).
  - `disposition` *(string, required)*: One of:
    - `"pending"`
    - `"accepted"`
    - `"implemented"`
    - `"partially_implemented"`
    - `"rejected_with_reason"`
    - `"superseded"`
    - `"stale"`
    - `"needs_reconsultation"`
  - `reason` *(string, optional, required for rejections)*: Explanation for the decision.
  - `cwd` *(string, optional)*: Working directory.
- **Returns**:
  ```json
  {
    "content": [{ "type": "text", "text": "Disposition for A1 updated to implemented." }],
    "details": {
      "ok": true,
      "consultationId": "adv-c902-1",
      "actionItemId": "A1",
      "disposition": "implemented"
    }
  }
  ```

---

## Autonomous Worker Agent Patterns

When building agentic loops in Pi, worker models should follow these recommended patterns:

### Pattern 1: Pre-Implementation Planning
1. Worker calls `advisor_consult(kind: "plan", goal: "...")`; it performs the common preflight and submission path.
2. Worker evaluates the returned advice and reads action items (`A1`, `A2`, `A3`) when the result is complete or degraded.
3. If a low-level diagnostic is needed, worker may call `advisor_preflight` to inspect commit/capability readiness.
4. For each action item:
   - Worker implements code and writes tests.
   - Worker runs tests to verify.
   - Worker calls `advisor_disposition(actionItemId: "A1", disposition: "implemented")`.

### Pattern 2: Adversarial Audit Gate
1. After completing a critical security or concurrency feature, worker commits and pushes to branch.
2. Worker calls `advisor_consult(kind: "audit", goal: "Audit lock acquisition order and failure recovery")`.
3. If the adviser identifies critical vulnerabilities, worker implements fixes.
4. If an adviser recommendation is inapplicable (e.g. contradicted by project constraints), worker records:
   `advisor_disposition(actionItemId: "A2", disposition: "rejected_with_reason", reason: "Contradicts zero-dependency constraint in ADR-04")`.

### Pattern 3: Explicit asynchronous review
Use `advisor_consult(..., mode: "async")` only when the answer is not needed for the worker's immediate decision. The job is durable and a matching-session UI notification is best-effort; it does not inject or resume a worker turn. Call `advisor_status`/`advisor_read` before acting on the result.
