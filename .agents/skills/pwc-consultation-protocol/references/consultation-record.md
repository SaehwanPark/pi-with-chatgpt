# Consultation Record, Protocol Blocks, Drift, Disposition

Reference detail for `pwc-consultation-protocol`. Field names are the V1 contract vocabulary
from `docs/pi-with-chatgpt-PROPOSAL.md`; keep them consistent across `git/`, `jobs/`,
`protocol/`, `ledger/`, and `drift/`.

## 1. Consultation identity

```yaml
consultation_id: adv-014          # stable, allocated before dispatch
repo: owner/name                  # canonical owner/repo from the selected GitHub remote
branch: feat/ownership            # advisory; may move or disappear
requested_ref: HEAD               # mutable, human-friendly
resolved_commit: <full 40-char SHA>   # immutable anchor
pr: 42                            # optional advisory metadata, never the anchor
```

```ts
interface ConsultationRefState {
  requestedRef: string
  resolvedCommit: string
  headAtDispatch: string
  headAtReceipt?: string
}
```

## 2. Ledger record

Global, repository-scoped, append-oriented; never repo-visible by default.

```text
~/.pi/agent/pi-with-chatgpt/
  repositories/<repo-id>/
    consultations.jsonl
    responses/<consultation-id>.md
    tasks/<task-id>.json
```

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
  "projectId": "...",
  "conversationId": "...",
  "status": "complete",
  "responsePath": "responses/adv-014.md",
  "actionItems": [{ "id": "A1", "disposition": "implemented" }]
}
```

Lookup must stay efficient by: consultation id, repository, task, commit, status, date. Store
large responses beside the index, write the index transactionally, and keep full historical
advice out of Pi model context by default.

## 3. Request brief

```text
CONSULTATION: adv-014
TYPE: audit
REPOSITORY: owner/repo
BRANCH: feat/ownership
CHECKPOINT: <full SHA>
PR: #42

GOAL: <what the work is trying to achieve>
CURRENT APPROACH: <what is being done now, when relevant>
CONCERN: <the specific risk or open question>
QUESTION: <what the adviser must decide or produce>

INSTRUCTION: Inspect the repository yourself through GitHub. Treat CHECKPOINT as the
authoritative repository state. Do not implement anything. Do not ask for pasted or uploaded
files. Development may advance while you reason. Provide reasoning and actionable
recommendations.
```

Never include: code listings, local logs, screenshots, build output, benchmark data, secrets,
or a summary of what the repository "currently contains" — the adviser verifies that itself.

## 4. Response block

```text
ADVISOR
consultation: adv-014
reviewed_commit: <full SHA>
status: actionable | inconclusive | blocked

ASSESSMENT
...

RECOMMENDATION
...

ACTION ITEMS
A1. ...
A2. ...

RISKS
...

OPTIONAL IDEAS
...
```

Parsing rules: keep the raw text; extract fields opportunistically; on a missing action id or a
deviating header, degrade to "raw response preserved, structure partial" instead of failing; on
a `reviewed_commit` that does not match the anchor, mark provenance ambiguous and never rewrite
the anchor.

## 5. Drift classes

| Checkpoint vs current HEAD | Class | Worker guidance |
| --- | --- | --- |
| equal | `current` | apply normally |
| checkpoint is an ancestor | `likely applicable` / `materially stale` | check relevant drift before applying |
| histories diverged | `needs reconsultation` | strong revalidation signal |
| object unreachable remotely | `provenance degraded` | advice stays anchored, evidence is degraded |

Relevant drift = files changed since the checkpoint that the advice named, plus their
interfaces, tests, config, and dependency changes. Surface it as:

```text
Adviser reviewed 8f731e2. Current HEAD is da5c991, 3 commits ahead.
Relevant drift: src/runtime/ownership.ts, tests/ownership.test.ts
Recommendations A2 and A4 may need revalidation.
```

## 6. Action-item disposition

```text
accepted | implemented | partially_implemented | rejected_with_reason | superseded | stale | needs_reconsultation
```

Rejection and supersession must keep their reason (`A2 rejected — conflicts with required
backward compatibility`). A follow-up consultation includes the original checkpoint, the new
checkpoint, and the prior action items with dispositions, and asks the adviser to inspect the
new GitHub state rather than trust prose.

Reconsult when materially affected implementation changed, an advice assumption no longer
holds, histories diverged, the worker explicitly asks for revalidation, or high-risk items are
unresolved — not merely because HEAD moved.
