# Consultation protocol

Status: M5 durable job model and storage. Browser dispatch, synchronous/asynchronous execution,
Pi delivery, and commands remain unfinished. M6 will add semantic briefs, response parsing,
provenance assessment, and the append-oriented adviser ledger.

## Immutable job identity

`jobs/record.ts` defines version 1 of the job file. A consultation receives an `adv-…` ID before
dispatch. Its selected GitHub repository/remote, requested ref, full resolved SHA, branch, task,
request kind, execution mode, dependency, creation time, and Pi delivery digest are fixed at creation.
Only anchors marked remotely available by the checkpoint resolver may enter the queued store.
That assertion records the resolver's evidence; reading a stored job is not a new GitHub probe.

The requested ref is metadata; the resolved SHA is authoritative. Receipt HEAD is a separate
observation and never replaces that SHA. No store method stages, commits, pushes, launches a browser,
executes adviser text, or publishes advice.

The default record mode is `async`; the default dependency is `advisory`. The store preserves an
explicit `required` choice. The execution layer must interpret provider failure through that flag.

## Local storage

Paths derive from `config/state-layout.ts`, under the extension-owned global state root:

```text
pi-with-chatgpt/
  jobs/<consultation-id>.json
  locks/job-<consultation-id>.lock
  repositories/<repo-id>/responses/<consultation-id>.json
```

Files use mode `0600`, managed directories `0700`. Writes use a private temporary file and atomic
rename on the same filesystem. Managed directory and file symlinks are refused. Unknown schema
versions, malformed fields, wrong file identity, and credential-shaped content fail closed.
Absent files remain distinct from corrupt, unreadable, or busy state. Exceptions exposed by the
store carry fixed codes, without filesystem paths or raw browser/provider diagnostics.

Each response file contains the complete adviser text, result metadata, and its job/repository/task/
delivery/checkpoint identity. The record stores the deterministic relative response path and SHA-256
of the text. Reads validate both identity and content digest. Responses are untrusted data; persistence
does not promote them to execution authority. Secret-shaped responses are refused without persisting
the offending text, consistent with the existing credential containment rule.

## Transactions and recovery

`ConsultationJobStore` exposes `create`, `get`, `claim`, `complete`, `fail`, `cancel`, and
`readPersistedResponse`. Each mutation holds a same-host advisory lock for that consultation ID.
There is no general record-update API that can rewrite the original anchor or delivery address.

- Creation refuses an existing or corrupted job; it never overwrites it on retry.
- Claim persists `queued → running` with Project/conversation binding and dispatch HEAD before
  returning `claimed: true`. Only one caller can claim a job. Browser submission must occur after
  that result in the forthcoming dispatcher.
- Completion writes the response first, then persists `running → completed`. Duplicate or late
  terminal callbacks return the existing terminal record unchanged. Completion and cancellation
  share the same lock, so the first persisted terminal transition wins.
- A crash between response and terminal writes leaves a running job with a readable response.
  `readPersistedResponse` exposes that artifact for explicit reconciliation. Retrying the same
  completion can commit it; attempting to substitute a different response is refused.
- A restarted process cannot claim a running job again. Whether its browser submission happened
  is ambiguous, so this store never requeues or resubmits it automatically.

Atomic rename protects against interrupted process writes; this is not a power-loss or distributed
filesystem durability claim. The store does not yet reconcile browser state after Pi exits.

## Delivery identity

Every internal lookup requires consultation ID, repository, task, and `deliveryKey`. The key is a
SHA-256 digest derived from the Pi session identifier, not a raw Pi identifier or ChatGPT web-session
credential. Changing any address component refuses the read or mutation. These internal records
must be projected into a compact worker-facing result, never serialized wholesale into model context.

Actual wake-up remains M5 execution work. It must persist the result first and verify a live endpoint
for the matching Pi session/task; an absent or ambiguous endpoint must leave the result for explicit
reading. A UI notification on whichever session is focused is not targeted delivery.

## Remaining execution integration

The browser currently has one tracked tab. Conversation selection and prompt submission must be
protected as one operation: calling mapping setup and `runtime.consult()` independently leaves a gap
where another task can navigate the tab. The dispatcher must also preserve serialization until a
cancelled browser turn has actually settled. These are prerequisites to claiming the M5 two-task
consultation exit criterion, not guarantees supplied by the job store.

Evidence for this storage slice: `jobs/record.test.ts`, `jobs/store.test.ts`, and `jobs/state.test.ts`.
No live adviser consultation or async Pi wake-up is claimed by these tests.
