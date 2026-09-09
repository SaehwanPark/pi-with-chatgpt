# Adviser Failure Matrix

Reference detail for `pwc-adviser-runtime`. Every row states the **required** observable
behaviour: what the job record becomes, what the worker sees, and what the user can do.
`advisory` failures never block local Pi work; `required` consultations surface once, clearly,
then stop waiting.

| Failure | Job state | Worker-visible result | User recovery |
| --- | --- | --- | --- |
| ChatGPT session expired | `failed:auth_expired` | auth needed; no advice | `/advisor-auth` |
| CAPTCHA / 2FA / consent | `blocked:challenge` | interactive step required | finish in adviser browser |
| Quota exhausted | `failed:quota` | adviser unavailable | retry later / continue locally |
| Strong model missing | `failed:capability` | capability mismatch, **no silent weaker fallback** | change model config |
| GitHub connector missing | `failed:connector` | advice would have no code context | enable connector |
| Repo not visible to connector | `failed:repo_access` | target repo unreadable to adviser | grant access / pick repo |
| Checkpoint not remote | `rejected:not_remote` | structured not-pushed result | push under normal git rules |
| Project deleted / renamed | `blocked:project` | mapping invalid, provenance kept | remap explicitly |
| Conversation deleted | auto-replaced, noted | new conversation + task handoff | none |
| Browser crash mid-job | retried once, else `failed:browser` | retry or continue locally | restart runtime |
| Response timeout | `failed:timeout` | bounded wait ended | re-dispatch |
| Partially malformed reply | `completed:degraded` | raw text preserved, structure partial | read raw |
| Reviewed SHA mismatch | `completed:provenance_ambiguous` | ambiguous provenance flagged | verify manually |
| Duplicate completion | idempotent, first wins | single result | none |
| Cancel/complete race | last persisted state wins | consistent state | none |
| Pi exited mid-job | durable, undispatched wake-up | `/advisor-read` after restart | read explicitly |
| Wake-up target ambiguous | result stored, **no wake-up** | none (never guess a session) | `/advisor-status` |
| Commit unreachable after force push | `degraded:provenance` | anchor kept, evidence degraded | reconsult at new SHA |
| Account mismatch | `blocked:account` | explicit conflict, never auto-switch | choose account |

## Recovery drill (run before closing M2/M3/M9 work)

1. Expire or remove the adviser profile → confirm no advice is invented and `/advisor-auth`
   restores service without touching the active browser.
2. Kill the browser mid-generation → confirm one bounded retry, then a durable `failed:browser`
   record with credentials absent from every log.
3. Launch two consultations for two tasks in one repo → confirm distinct conversations, distinct
   jobs, and no cross-delivery.
4. Kill the Pi session after async dispatch → confirm the result survives and is retrievable by
   consultation id after restart.
5. Force-push the reviewed branch → confirm the anchor stays and provenance is reported as
   degraded rather than retargeted.

## Removable vendor heuristics

Keep here, not in the workflow contract: polling interval and backoff curve, max dispatch
retries, DOM selector fallbacks, generation-complete heuristics, capability-check cache TTLs,
and browser warm-up delays. Each must be overridable, bounded, and deletable without changing
the state machine or the failure semantics above.
