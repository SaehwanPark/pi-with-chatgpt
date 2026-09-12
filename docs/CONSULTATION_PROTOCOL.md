# Consultation protocol

Status: durable job model, storage, terminal reconciliation, append-oriented ledger, browser dispatch,
synchronous/asynchronous execution, Pi delivery, and command/tool wiring are implemented behind the
lazy production composition root. Live ChatGPT/browser round trips remain manual verification work.

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

`ConsultationJobStore` exposes `create`, `get`, `getByConsultationId`, `list`, `claim`, `complete`,
`fail`, `cancel`, `reconcileRunningJobs`, and `readPersistedResponse`. Each mutation holds a
same-host advisory lock for that consultation ID. Engine callers can resolve and cancel by ID only
after the store supplies the immutable address; callers must not synthesize delivery fields.
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
- A restarted process cannot claim a running job again. `reconcileRunningJobs` transitions each
  stale `running` record to terminal `failed` with the closed `interrupted` reason. Whether its
  browser submission happened is ambiguous, so this store never requeues or resubmits it
  automatically.

Atomic rename protects against interrupted process writes; this is not a power-loss or distributed
filesystem durability claim. `ConsultationLedger.recordTerminalJob` projects failed, cancelled,
and interrupted terminal jobs into history exactly once, while the JobStore remains live status
authority. Action-item disposition rewrites use the same sibling-temp-file + rename primitive.

## Delivery identity

Every internal lookup requires consultation ID, repository, task, and `deliveryKey`. The key is a
SHA-256 digest derived from the Pi session identifier, not a raw Pi identifier or ChatGPT web-session
credential. Changing any address component refuses the read or mutation. These internal records
must be projected into a compact worker-facing result, never serialized wholesale into model context.

The execution engine persists a result before notifying a listener registered for the matching session
delivery digest. The extension binds and removes that listener through Pi's session lifecycle; an absent
or ambiguous endpoint leaves the result available for explicit status/read queries. A UI notification on
whichever session is focused is not targeted delivery.

## Execution boundary

The browser currently has one tracked tab. Conversation selection, model selection, prompt submission,
and response reading are serialized by the engine's V1 global browser slot and the runtime's turn queue;
the dispatcher waits for cancellation cleanup before returning. A future conversation-scoped page can
relax that limit, but no parallel browser turns are advertised today.

Evidence: `jobs/record.test.ts`, `jobs/store.test.ts`, `jobs/state.test.ts`, `jobs/engine.test.ts`,
`extension/index.test.ts`, and `test/m9-concurrency-recovery.test.ts`. Live ChatGPT round trips remain
manual verification work.
