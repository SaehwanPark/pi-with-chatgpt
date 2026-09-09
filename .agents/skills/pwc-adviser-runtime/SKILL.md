---
name: pwc-adviser-runtime
description: Implement or debug the pi-with-chatgpt execution machinery — OpenAI identity reuse, isolated ChatGPT browser profile, session import and manual login, capability verification, ChatGPT Project and task-conversation mapping, and the synchronous/asynchronous consultation job engine.
---

# Adviser Runtime

## When to Use

- implementing or reviewing `auth/`, `browser/`, `chatgpt/`, or `jobs/` behaviour
- debugging login, capability, model-selection, Project-mapping, wake-up, or race failures
- deciding how a provider/auth/browser failure must surface to the worker and the user

Do **not** use for checkpoint resolution, protocol shapes, ledger schema, or drift — use
`pwc-consultation-protocol`.

## Required Inputs

- which surface is in scope (identity, browser runtime, Project/conversation mapping, job engine)
- observed state: persisted adviser profile? Pi OpenAI/Codex credential? account identifiers?
- platform (macOS / Linux / Windows) when profile discovery or encrypted cookie storage matters
- the consultation's `dependency` (`advisory` or `required`)

## Layering Rules

Two identity layers, deliberately not merged:

1. **OpenAI identity** — reuse Pi's existing `openai-codex` OAuth credential through supported
   Pi abstractions rather than reimplementing token refresh. Use it for account identity,
   workspace matching, and entitlement *hints*. Codex OAuth tokens are **not** assumed usable as
   ChatGPT web sessions, and the active Pi worker model must never have to be OpenAI.
2. **ChatGPT web session** — a dedicated, extension-owned browser profile in OS-appropriate
   state storage (`~/.pi/agent/pi-with-chatgpt/browser/chatgpt-profile/`), with restrictive
   filesystem permissions.

Resolution order: persisted adviser profile → Pi OpenAI/Codex identity → optional Codex CLI
identity → explicit one-time import from a Chromium-family profile → manual login inside the
isolated adviser browser.

Never silently switch OpenAI/ChatGPT accounts. When Pi-side identity and browser-side identity
disagree, stop and give the user an explicit choice. Treat plan labels as hints: verify the
capability that is actually needed (authenticated, strong model present, GitHub connector
present, target repository visible) and revalidate after a meaningful auth failure.

## Browser Runtime Rules

- The extension owns **only** its dedicated adviser browser runtime. Never automate the user's
  active browser for normal jobs, never hijack a global browser tool, never mutate another
  extension's state.
- Browser control is extension-owned, not worker-operated: the worker calls structured adviser
  primitives and never receives DOM knowledge.
- Lazy start, reuse while healthy, recover from crashes and stale tabs, shut down cleanly, and
  keep persistent auth state separate from ephemeral task state.
- Prefer semantic DOM operations over coordinates/screenshots; detect generation-in-progress,
  completed assistant turns, visible provider errors, and login/challenge pages explicitly.
- No long single blocking wait: use bounded polling with backoff (see *Removable heuristics*).
- Diagnostics must be sufficient to debug a failure without recording credentials, cookies, or
  session tokens — anywhere, including logs the user never sees.
- Model selection defaults to `auto-best`; a configured model that is unavailable is reported,
  not silently replaced by a weaker/free model.

## Project and Conversation Rules

- Exactly one ChatGPT Project per GitHub repository, keyed by stable repository identity,
  persisted locally, reused across sessions, recovered on rename/delete, and protected against
  duplicate creation during concurrent setup.
- One adviser conversation per Pi task; follow-ups reuse it; unrelated tasks start fresh. Writes
  to one conversation are serialised; different conversations may run in parallel.
- Project instructions are concise and stable: bound to one GitHub repo, Pi executes while
  ChatGPT advises, the requested SHA is authoritative, inspect GitHub directly, never ask for
  pasted files, Project memory ranks below checkpoint code. Keep ephemeral branch/commit values
  out of Project instructions.
- Trust order when information conflicts: code at the requested commit → consultation brief →
  task conversation history → Project instructions → Project memory.
- A deleted or stale conversation is replaced inside the same Project with a concise task
  handoff; Project memory is never a substitute for checkpoint provenance.

## Job Engine Rules

State machine: `queued → running → completed | failed | cancelled`.

- Persist the job **before** browser submission; persist the result **before** wake-up delivery.
- Sync mode: bounded wait, cancellable, clean error surfacing, result still durable if the UI is
  interrupted.
- Async mode: dispatch without blocking the worker, persist detached state, deliver a
  best-effort wake-up to the **matching** Pi session, and keep the result retrievable
  (`/advisor-status`, `/advisor-read`) even when the wake-up is missed.
- Delivery correctness is absolute: never wake the wrong session, never attach repo A's result
  to repo B, never attach task A's conversation to task B. Ambiguous recovery is handled
  manually, never guessed.
- Bound concurrency with a conservative default; serialise within a conversation; prevent
  Project-creation, auth-maintenance, duplicate-dispatch, cancel/complete, and shutdown/wake-up
  races.

## Failure Policy

Read `references/failure-matrix.md` for the per-failure behaviour table. The governing rules:
durable job state first, best-effort wake-up second, `advisory` failures do not block local
work, never silently retarget a commit, never silently switch accounts, and always preserve
enough state for an explicit, user-initiated repair.

## Outputs

- implementation, tests, or findings for the surface in scope
- `_workspace/04_verify_report.md` with the recovery drills actually executed
- doc sync: `AUTHENTICATION.md`, `TROUBLESHOOTING.md`, `SECURITY.md` on behaviour changes

## Removable Heuristics

Polling intervals, backoff curves, retry counts, DOM selector fallbacks, and generation-complete
guesses are vendor-specific. Keep them isolated in this reference so they can be deleted or
replaced when the provider or model improves, without touching the workflow contract.
