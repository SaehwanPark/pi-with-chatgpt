# pi-with-chatgpt: Resilient Autonomous Adviser UX Implementation Plan

## 1. Objective

Implement a focused **resilient autonomous adviser UX** upgrade for `pi-with-chatgpt`.

The extension should satisfy two user-facing expectations:

1. **ChatGPT failure must never wedge Pi**

   * A hung browser operation, stalled generation, disconnected stream, provider error, or broken ChatGPT UI must resolve to a bounded and understandable failure.
   * Advisory failure should preserve the existing default behavior: Pi continues working locally unless the user explicitly configured adviser availability as required.
   * A failed consultation must not poison later consultations indefinitely.

2. **Agents should naturally use ChatGPT when instructed to do so**

   * If the user or trusted `AGENTS.md` says something like:

     * "Use ChatGPT as adviser."
     * "Consult ChatGPT before implementing this."
     * "Get a second opinion from ChatGPT after the implementation."
   * the Pi worker should have a clear, high-level tool and tool policy that causes it to invoke the adviser without requiring the user to remember slash commands.
   * No brittle regex-based interpretation of user prompts should be implemented inside the extension.

This work should build on the current architecture rather than replace it.

---

# 2. Scope

## In scope

* Whole-consultation hard deadlines.
* Browser-operation deadlock containment.
* Browser/runtime poisoning and recovery semantics.
* Propagation of Pi's tool cancellation signal.
* Progress reporting through Pi's tool-update callback.
* Detection of truncated/incomplete ChatGPT responses.
* Stronger adviser-response completion provenance.
* A high-level `advisor_consult` agent tool.
* Agent-facing routing guidance.
* Explicit agent-use configuration semantics.
* Sensible synchronous behavior for autonomous adviser calls.
* Optional session-scoped async result delivery where Pi exposes a supported API.
* Circuit-breaking after repeated transport failures.
* Regression tests and live autonomous-worker evaluations.
* Documentation updates.

## Out of scope

* Giving ChatGPT execution authority.
* Allowing ChatGPT to edit the repository.
* Sending local files directly to ChatGPT.
* Replacing the GitHub-only checkpoint architecture.
* Supporting multiple simultaneous browser tabs.
* Automatically solving CAPTCHA or authentication challenges.
* Broad redesign of Project/conversation mapping.
* Browser-process isolation in a separate OS process unless the in-process watchdog proves insufficient.
* Automatic proactive consultation on every important-looking decision by default.

The core asymmetry remains:

```text
ChatGPT advises.
Pi decides and executes.
```

---

# 3. Existing invariants to preserve

The implementation must preserve the project's existing guarantees:

* GitHub remains the only repository context channel to ChatGPT.
* Consultations remain anchored to verified remote commit SHAs.
* ChatGPT receives no git write authority.
* The adviser browser remains isolated from the user's personal browser profile.
* A single V1 adviser tab remains serialized.
* Project trust remains mandatory for automated adviser access.
* Failed advisory consultations remain non-blocking by default.
* Job state remains durable before browser activity begins.
* First-terminal-winner semantics remain authoritative for cancellation/failure/completion races.
* Pi sessions and logical adviser conversations remain properly isolated.
* Human verification remains a terminal human-required state rather than something the agent retries automatically.

---

# 4. Target user experience

## 4.1 Normal explicit autonomous consultation

User:

```text
Implement the new scheduler. Use ChatGPT as adviser for the design before coding.
```

Expected worker flow:

```text
worker recognizes explicit adviser instruction
    ↓
advisor_consult(kind="plan", goal="Design the scheduler...")
    ↓
extension validates checkpoint / auth / capability
    ↓
ChatGPT consultation
    ↓
validated complete response
    ↓
worker receives advice
    ↓
worker decides what to adopt
    ↓
implementation continues
```

The user should not need to know that `advisor_preflight` and `advisor_submit` exist.

---

## 4.2 ChatGPT provider failure

```text
advisor_consult(...)
    ↓
ChatGPT displays provider error
    ↓
consultation → failed(provider-error)
    ↓
worker receives:
"ChatGPT adviser unavailable; continuing locally."
    ↓
worker continues
```

No repeated retry loop.

---

## 4.3 ChatGPT generation hangs while page remains responsive

```text
message submitted
    ↓
ChatGPT keeps generating
    ↓
browser heartbeat remains healthy
    ↓
hard generation deadline reached
    ↓
tab reset
    ↓
consultation → timed-out
    ↓
worker continues locally
```

---

## 4.4 Browser/Playwright itself hangs

```text
browser operation never settles
    ↓
outer transaction watchdog fires
    ↓
consultation abort signal fired
    ↓
browser generation invalidated
    ↓
emergency context reset attempted outside normal queue
    ↓
job terminally fails
```

If recovery succeeds:

```text
next consultation → fresh browser context → normal operation
```

If recovery cannot be proven safe:

```text
adviser runtime → poisoned
future adviser calls → fail fast
Pi/local work → continues normally
```

Nothing should wait forever behind the poisoned transaction.

---

## 4.5 ChatGPT stream disconnects after producing partial text

Example:

```text
consultation: adv-123
reviewed_commit: ...
status: actionable

ASSESSMENT
...

RECOMMENDATION
The first thing I would change is...
<stream stops>
```

Expected behavior:

```text
assistant DOM node appears finished
BUT completion sentinel missing
    ↓
response → incomplete
    ↓
partial text retained only as diagnostic evidence
    ↓
no action items treated as authoritative
    ↓
worker informed that adviser response was incomplete
    ↓
worker continues locally or explicitly retries/follows up
```

A partial answer must not silently become normal advice.

---

# 5. Architecture changes

## 5.1 Separate three concepts that are currently too closely coupled

The implementation should distinguish:

### Job state

```text
queued
running
completed
failed
cancelled
```

This answers:

> What happened to the consultation job?

### Transport/runtime outcome

Examples:

```text
success
generation-timeout
transaction-timeout
browser-lost
browser-unresponsive
provider-error
needs-human
cancelled
```

This answers:

> What happened while communicating with ChatGPT?

### Advice validity

Examples:

```text
verified
degraded
incomplete
provenance-ambiguous
```

This answers:

> Is the returned text safe for the worker to treat as adviser output?

Do not overload one boolean `ok` with all three meanings internally.

---

# 6. PR 1 — Hard deadline and deadlock containment

## Goal

Guarantee that one non-settling browser operation cannot leave the extension permanently waiting.

## Primary files

Likely affected:

```text
browser/transaction.ts
browser/runtime.ts
browser/runtime-types.ts
browser/playwright-driver.ts
browser/adviser-runtime.ts
extension/services.ts
jobs/engine.ts
jobs/record.ts
jobs/engine.test.ts
browser/runtime.test.ts
browser/playwright-driver.test.ts
browser/transaction.test.ts        # new if useful
```

---

## 6.1 Introduce explicit transport failure codes

Add or normalize failure classifications such as:

```ts
type ConsultationFailure =
  | "generation-timeout"
  | "transaction-timeout"
  | "browser-unresponsive"
  | "browser-lost"
  | "browser-poisoned"
  | "provider-error"
  | "needs-human"
  | "model-unavailable"
  | "response-unreadable"
  | "incomplete-response"
  | "cancelled";
```

Do not collapse all watchdog failures into `"browser"`.

The worker does not need every low-level detail, but durable state and diagnostics should retain the real category.

---

## 6.2 Add a whole-transaction deadline

The existing generation timeout is not enough because it operates inside browser polling.

Add an outer deadline around the complete browser transaction:

```text
capability gate
Project resolution
conversation resolution
navigation
model selection
prompt submission
generation
response receipt
```

This deadline must encompass calls that can become stuck before `askAndAwaitTurn()` reaches its polling deadline.

### Configuration

Avoid adding another value most users must tune.

Recommended derivation:

```text
generation timeout = syncTimeoutMs
transaction timeout = syncTimeoutMs + fixed recovery/navigation allowance
```

For example:

```text
syncTimeoutMs        = 240 s
transaction allowance = 60 s
outer bound          = 300 s
```

The allowance should be an internal constant initially.

Expose an advanced override only if real-world testing demonstrates a need.

---

## 6.3 Make queued lock acquisition abortable

Both the engine concurrency queue and process-wide browser transaction scheduler should accept an `AbortSignal`.

A request cancelled while waiting for the adviser tab should leave the queue immediately rather than wait until every earlier consultation completes.

Conceptually:

```ts
runExclusive(operation, {
  signal,
  ...
})
```

Waiting requests should settle as cancelled without acquiring the transaction.

---

## 6.4 Never "solve" a hung transaction by simply releasing the mutex

This is critical.

Do **not** implement:

```text
Promise.race(operation, timeout)
    ↓ timeout
release mutex
    ↓
allow next browser operation
```

while the old browser operation is still alive.

That would allow two logical owners of the same tracked ChatGPT tab and recreate the cross-conversation race already fixed in the project.

Instead use:

```text
timeout
    ↓
mark current transaction invalid
    ↓
abort consultation
    ↓
invalidate browser generation/epoch
    ↓
force browser/context recovery
    ↓
only then permit reuse
```

---

## 6.5 Add browser generation/epoch invalidation

Give every browser runtime generation a monotonically increasing identifier.

Example:

```text
browser generation 17
    ↓
consultation starts with generation 17
    ↓
watchdog expires
    ↓
generation becomes 18
```

Any late continuation belonging to generation 17 must be unable to publish a successful adviser result.

This complements existing first-terminal-winner job semantics.

---

## 6.6 Add an emergency recovery path outside the normal DOM queue

Normal shutdown/reset currently travels through normal ownership paths. That is insufficient if those paths themselves are wedged.

Introduce a narrowly scoped emergency capability owned by the browser supervisor, for example:

```ts
interface AdviserBrowserRecovery {
  invalidate(reason: RecoveryReason): void;
  emergencyClose(): Promise<RecoveryResult>;
}
```

The recovery path should:

1. mark the current runtime generation invalid;
2. abort the active consultation;
3. attempt to close/reset the tracked BrowserContext independently of the blocked DOM transaction;
4. clear stale page/context references;
5. establish whether the profile is safely reusable;
6. only create a new context after the previous ownership state is known.

---

## 6.7 Introduce a poisoned runtime state

If emergency browser recovery itself cannot complete within a bounded grace period, do not continue waiting.

Set:

```text
runtime state = poisoned
```

Then:

```text
future adviser request
    ↓
immediate failure: browser-poisoned
```

Pi remains usable.

The error should recommend an adviser/browser restart, but adviser failure should not block local work under `dependencyDefault="advisory"`.

This is preferable to risking concurrent browser owners.

---

## 6.8 Add late-completion barriers

After every significant awaited browser operation, check the consultation abort/generation state before proceeding.

Especially before:

```text
claiming success
persisting response
recording successful ledger entry
notifying the worker
```

A late browser result must not resurrect a timed-out/cancelled job.

---

## PR 1 acceptance criteria

* A deliberately never-resolving browser operation does not leave `advisor_consult` pending indefinitely.
* Cancellation while waiting for the browser transaction settles promptly.
* A timed-out old transaction cannot overwrite terminal job state.
* A safely reset browser can service the next consultation.
* An unrecoverable browser enters `poisoned` state and later calls fail fast.
* Pi/local work remains unaffected.
* Existing single-tab serialization tests continue to pass.

---

# 7. PR 2 — Response completion integrity

## Goal

Prevent truncated ChatGPT output from being accepted as complete actionable advice.

## Primary files

```text
chatgpt/project-instructions.ts
protocol/brief.ts
protocol/response.ts
protocol/response.test.ts
jobs/record.ts
jobs/engine.ts
ui/worker-facing.ts
docs/CONSULTATION_PROTOCOL.md
```

---

## 7.1 Add a final completion sentinel

Every adviser response must end with a consultation-specific terminal marker.

Recommended format:

```text
consultation_complete: <consultation-id>
```

For example:

```text
consultation: adv-c902-1
reviewed_commit: abcdef012345...
status: actionable

## ASSESSMENT
...

## RECOMMENDATION
...

## ACTION ITEMS
A1. ...
A2. ...

consultation_complete: adv-c902-1
```

The marker should be requested in both:

* ChatGPT Project instructions; and
* each consultation brief.

The consultation-specific value prevents an old response from accidentally satisfying the check.

---

## 7.2 Parse completion provenance separately

Extend the parser with something similar to:

```ts
completion:
  | "verified"
  | "missing"
  | "mismatched"
  | "malformed"
```

The response is fully usable only if:

```text
consultation ID matches
AND reviewed commit matches
AND completion marker matches
```

---

## 7.3 Introduce `incomplete` advice status

Extend result status:

```ts
type JobResultStatus =
  | "complete"
  | "degraded"
  | "incomplete"
  | "provenance-ambiguous";
```

`incomplete` means:

> ChatGPT produced text, but the extension could not prove that the response finished.

---

## 7.4 Never expose incomplete action items as normal actionable output

For an incomplete response:

```text
raw text → may be retained for diagnostics
parsed action items → not promoted as normal pending recommendations
worker-facing advice → marked unusable/incomplete
```

The worker-facing response should say something like:

```text
The ChatGPT adviser response appears incomplete and was not accepted as actionable advice.
Continue locally or request a follow-up/retry.
```

Avoid feeding a truncated recommendation directly into autonomous implementation.

---

## 7.5 Do not blindly retry ambiguous partial streams

Do not automatically resubmit an identical consultation after partial output.

Reasons:

* it may duplicate a valid but sentinel-less answer;
* it may produce multiple concurrent semantic answers;
* it may unnecessarily consume account capacity;
* it complicates provenance.

A future recovery strategy can use an explicit continuation turn.

For this milestone, fail safely and make the partial response inspectable.

---

## PR 2 acceptance criteria

Test at least:

```text
valid complete response                → complete
missing terminal marker                → incomplete
wrong terminal consultation ID         → provenance-ambiguous/incomplete
truncated midway through recommendation → incomplete
empty response                         → incomplete/failure
correct marker but wrong SHA            → provenance-ambiguous
correct SHA but wrong consultation ID    → provenance-ambiguous
```

No incomplete case should expose normal actionable items to the worker.

---

# 8. PR 3 — Cancellation propagation and progress UX

## Goal

Make Pi's own tool lifecycle control the adviser lifecycle and make long adviser calls visibly alive.

## Primary files

```text
extension/pi-api.ts
extension/tools.ts
jobs/engine.ts
browser/runtime.ts
browser/runtime-types.ts
extension/tools.test.ts
jobs/engine.test.ts
```

---

## 8.1 Stop discarding Pi's `AbortSignal`

Current tool handlers receive a signal but do not propagate it.

Change:

```ts
execute(..., _signal, _onUpdate, ...)
```

to actually use:

```ts
execute(..., signal, onUpdate, ...)
```

For synchronous consultation:

```text
Pi tool signal
    ↓
engine request.signal
    ↓
engine AbortController
    ↓
runtime
    ↓
Playwright polling/reset
```

For async submission, cancellation semantics should be explicit:

* cancellation before durable dispatch → cancel job;
* cancellation after async dispatch returned → normal `advisor_cancel` governs the detached job.

---

## 8.2 Add structured consultation progress events

Introduce an internal event vocabulary such as:

```text
preflight
waiting-for-browser
browser-ready
resolving-project
resolving-conversation
selecting-model
submitted
generating
recovering
completed
failed
```

Do not expose low-level selector details.

---

## 8.3 Wire progress into `onUpdate`

Examples visible to the worker/user:

```text
Verifying adviser prerequisites...
Waiting for the adviser browser...
ChatGPT consultation submitted...
ChatGPT is generating...
Adviser browser became unresponsive; attempting recovery...
ChatGPT adviser unavailable; continuing locally.
```

Progress updates must be best-effort and never affect consultation correctness.

---

## 8.4 Add browser heartbeat semantics

Do not equate:

```text
"No new assistant token for 30 seconds"
```

with:

```text
"The browser is hung."
```

Reasoning models can legitimately think for an extended period.

Instead track transport/browser heartbeat:

```text
successful DOM snapshot / browser response
    → browser alive
```

If heartbeat probes themselves stop completing, the outer watchdog handles the condition.

Optionally produce a non-fatal user-facing warning for long generation inactivity, but do not reset a healthy reasoning turn merely because visible text did not grow.

---

## PR 3 acceptance criteria

* Aborting an `advisor_consult`/`advisor_submit` tool call propagates to the engine.
* A touched browser turn is reset after cancellation.
* Progress appears for long-running consultations.
* Progress callbacks throwing/failing cannot break the consultation.
* Browser-responsive long reasoning does not trigger false stall recovery.

---

# 9. PR 4 — High-level autonomous `advisor_consult` tool

## Goal

Give worker models one obvious semantic interface for normal adviser use.

## Keep the existing tools

Do not remove:

```text
advisor_preflight
advisor_submit
advisor_read
advisor_status
advisor_followup
advisor_cancel
advisor_auth
advisor_disposition
```

They remain useful as advanced primitives and preserve compatibility.

Add:

```text
advisor_consult
```

as the preferred worker-facing entry point.

---

## 9.1 Proposed schema

```ts
advisor_consult({
  kind: "consult" | "plan" | "review" | "audit" | "debug" | "challenge",
  goal: string,
  mode?: "sync" | "async",
  taskId?: string
})
```

Do not require `cwd` from a normal worker; use context automatically.

---

## 9.2 `advisor_consult` should orchestrate the common path

Internally:

```text
resolve configuration
    ↓
verify trusted project
    ↓
resolve Pi session identity
    ↓
resolve Git/GitHub checkpoint
    ↓
verify ChatGPT auth/capability
    ↓
create consultation
    ↓
submit
    ↓
validate completion/provenance
    ↓
return worker-facing advisory
```

A worker should not normally need to call `advisor_preflight` itself.

The authoritative capability check in the engine should remain the final protection against TOCTOU issues.

---

## 9.3 Refactor common submission logic

Avoid implementing `advisor_consult` by duplicating `advisor_submit`.

Extract a shared internal operation such as:

```ts
submitConsultation(...)
```

or:

```ts
ConsultationService.consult(...)
```

Then:

```text
advisor_submit  ─┐
                 ├→ common consultation service
advisor_consult ─┘
```

The difference is worker-facing ergonomics and defaults, not core transport behavior.

---

# 10. Agent routing policy

## 10.1 Use Pi's tool prompt metadata

Populate the high-level tool's supported fields:

```ts
promptSnippet
promptGuidelines
```

The guidance should explicitly tell the worker when to use the adviser.

Recommended semantic policy:

```text
Use advisor_consult autonomously when the user or trusted project instructions explicitly ask you
to use, consult, obtain advice from, review with, or get a second opinion from ChatGPT/the ChatGPT
adviser.

Do not require the user to invoke a slash command.

Use the requested consultation at the appropriate workflow point:
- plan/consult before implementation when requested;
- review/audit after a checkpoint when requested;
- debug when local investigation reaches the decision point requested by the user.

ChatGPT advice is advisory. Evaluate it against repository evidence and project constraints.

If adviser access fails and adviser dependency is advisory, continue the task locally and report the
failure briefly.

Do not repeatedly retry unavailable adviser infrastructure.
```

---

## 10.2 Respect explicit negative instructions

The tool guidance must also state:

```text
Do not consult ChatGPT when the user explicitly says not to use ChatGPT, external advisers,
or external model assistance.
```

This should outrank proactive policy.

---

## 10.3 Do not implement phrase matching inside TypeScript

Avoid code such as:

```ts
if (/use chatgpt|ask chatgpt/i.test(prompt)) ...
```

The worker model already interprets language.

The extension should provide:

```text
capability + clear policy + safe execution
```

not become a second natural-language intent classifier.

---

# 11. Replace the misleading `autoConsult` configuration

The existing `autoConsult` fields currently have no behavior.

Introduce a configuration with explicit semantics, for example:

```json
{
  "pi-with-chatgpt": {
    "agentUse": {
      "mode": "explicit"
    }
  }
}
```

Recommended modes:

```text
off
explicit
proactive
```

### `off`

Agent tools do not autonomously consult ChatGPT.

User slash commands remain available.

### `explicit` — default

The worker should invoke `advisor_consult` when:

* the current user explicitly asks for ChatGPT advice; or
* trusted project instructions explicitly establish ChatGPT as an adviser.

This directly covers the desired:

```text
"Use ChatGPT as adviser."
```

behavior.

### `proactive`

The worker may also consult ChatGPT at appropriate high-value decision points without an explicit per-task request.

Examples:

```text
major architecture decision
security-sensitive implementation
hard debugging dead end
final adversarial review
```

`proactive` should be **global-user-authority only**.

A repository must not be able to enable it itself.

---

## 11.1 Project-scope authority

Project config may narrow user policy:

```text
global proactive → project explicit
global explicit  → project off
```

A project should not broaden:

```text
global explicit → project proactive   # reject
global off      → project explicit    # reject or keep off
```

This preserves user control over external model use.

---

## 11.2 Migration

Because `autoConsult` previously had no actual dispatch semantics:

1. introduce `agentUse`;
2. keep accepting `autoConsult` temporarily;
3. emit a deprecation notice in verbose diagnostics;
4. document that it is superseded;
5. remove it in a later breaking release.

Do not silently reinterpret old `autoConsult.enabled=true` as a new proactive policy.

---

# 12. PR 5 — Autonomous async semantics

## Goal

Ensure asynchronous adviser use does not become a one-way notification to the human while the worker remains unaware.

---

## 12.1 Default `advisor_consult` to sync

For autonomous decision-making:

```text
advisor_consult → sync
```

should be the default.

The agent usually asked the adviser because it needs the answer before its next decision.

This alone gives reliable autonomous behavior without requiring Pi session wake-up support.

---

## 12.2 Keep async explicit

Use async when:

* the user requests non-blocking consultation;
* the worker is doing independent work while review runs;
* advice is not required for the immediate next step.

---

## 12.3 Investigate supported Pi session delivery API

Before implementing context injection, verify the current supported Pi extension API.

If Pi provides a documented method for:

```text
send custom message to originating session
and/or
schedule/resume an agent turn
```

introduce a narrow adapter in `extension/pi-api.ts`.

Do not depend directly on undocumented Pi internals.

---

## 12.4 If supported, add worker delivery

Desired async lifecycle:

```text
worker submits async adviser job
    ↓
worker continues
    ↓
ChatGPT finishes
    ↓
extension persists advisory
    ↓
originating Pi session receives synthetic adviser-result message
    ↓
worker can incorporate advice on its next/resumed turn
```

Include:

```text
consultationId
checkpoint SHA
result status
short advisory summary
instruction to call advisor_read if full text is needed
```

Avoid dumping very long adviser responses directly into the worker context.

---

## 12.5 Add reentrancy protection

Synthetic adviser-result messages must carry an internal origin marker.

For example:

```text
origin = pi-with-chatgpt/adviser-result
```

Agent-use policy must never interpret the extension's own result message as a new request to consult ChatGPT.

This prevents:

```text
ChatGPT result
    ↓
worker sees "ChatGPT..."
    ↓
calls advisor_consult again
    ↓
loop
```

---

## 12.6 If Pi lacks a supported delivery primitive

Do not hack around it.

Keep:

```text
async → durable result + UI notification + advisor_read/status
```

and document it accurately as **asynchronous notification**, not autonomous worker wake-up.

Normal autonomous `advisor_consult` remains synchronous.

---

# 13. PR 6 — Adviser health and circuit breaker

## Goal

Prevent repeated adviser failures from wasting several minutes on every worker decision.

Introduce small process-local adviser health state.

Example:

```text
healthy
degraded
open
```

Suggested policy:

```text
successful consultation
    → healthy
```

Repeated transport/browser failures:

```text
3 failures within a short window
    → circuit open
```

While open:

```text
advisor_consult
    → fail fast with adviser-temporarily-unavailable
```

After cooldown or explicit recovery/auth action:

```text
half-open probe
    ↓ success → healthy
    ↓ failure → reopen
```

Human-required states should not be retried automatically through the breaker.

Keep this conservative and simple; do not build a generalized resilience framework.

---

# 14. Failure behavior matrix

| Condition                             | Job outcome                                        | Browser action               | Worker behavior                 |
| ------------------------------------- | -------------------------------------------------- | ---------------------------- | ------------------------------- |
| Normal complete response              | completed                                          | reuse                        | consume advice                  |
| Provider error before response        | failed                                             | reuse/reset if needed        | continue locally                |
| Generation exceeds limit              | failed/timed-out                                   | reset tab                    | continue locally                |
| Pi tool cancelled                     | cancelled                                          | reset touched turn           | stop adviser call               |
| Browser renderer unresponsive         | failed                                             | emergency reset              | continue locally                |
| Emergency reset succeeds              | failed current job                                 | fresh runtime allowed        | later consultations work        |
| Emergency reset cannot be proven safe | failed                                             | runtime poisoned             | future adviser calls fail fast  |
| Human verification                    | failed/needs-human                                 | preserve for manual recovery | continue locally                |
| Missing completion sentinel           | completed-incomplete or equivalent unusable result | usually reuse                | do not act on partial advice    |
| Wrong consultation/SHA provenance     | provenance-ambiguous                               | reuse                        | do not treat as verified advice |
| Circuit open                          | fail-fast                                          | no browser work              | continue locally                |

---

# 15. Testing strategy

## 15.1 Unit tests

Add deterministic tests for:

### Watchdog

```text
browser operation never resolves
→ outer deadline fires
→ job terminally fails
→ tool returns
```

### Queue poisoning

```text
A hangs
B waits

A exceeds hard deadline
recovery fails

B must not wait forever
B fails quickly with browser-poisoned
```

### Recovery

```text
A hangs
emergency recovery succeeds
B starts afterward
B completes normally
```

### Late completion

```text
A times out
old browser promise later resolves

A must remain failed
no successful ledger overwrite
```

### Cancellation propagation

```text
advisor_consult called with signal
signal.abort()

engine receives abort
job → cancelled
tab reset
```

### Incomplete response

```text
new assistant node + generating indicator gone
BUT no completion marker

→ incomplete
```

### Provenance

Test every combination of:

```text
consultation ID
reviewed SHA
completion ID
```

### Circuit breaker

```text
3 qualifying failures
→ circuit opens
next request fails without browser call
successful half-open probe
→ closes
```

---

# 16. Integration/concurrency tests

Add scenarios such as:

```text
A normal + B queued + C normal
```

and:

```text
A hung + B cancelled + C after browser recovery
```

and:

```text
workspace A consultation
workspace B consultation
browser reset between them
```

Verify there is never more than one active logical owner of the tracked adviser tab.

Also retain regression coverage for previous issues:

* hidden duplicate DOM controls;
* cancellation/completion terminal races;
* session-scoped task IDs;
* shared browser transaction serialization;
* connector/repository capability verification;
* profile ownership;
* restart reconciliation.

---

# 17. Real worker autonomy evaluation

Unit tests cannot prove that a worker model will actually decide to call `advisor_consult`.

Add a small live evaluation matrix.

Target at least:

```text
small/local worker model
inexpensive cloud worker model
```

The exact models can vary by environment.

## Evaluation prompt classes

### Explicit positive

```text
Use ChatGPT as adviser and ask it to review your implementation plan before coding.
```

Expected:

```text
advisor_consult called
```

### Trusted AGENTS instruction

`AGENTS.md`:

```text
For substantial architecture decisions, use ChatGPT as adviser before implementation.
```

Task contains a substantial architecture decision.

Expected:

```text
advisor_consult called at the appropriate decision point
```

### Delayed consultation

```text
Implement this first, then ask ChatGPT to audit the completed checkpoint.
```

Expected:

```text
implementation
commit/push
advisor_consult(kind="audit")
```

not consultation before implementation.

### Explicit negative

```text
Do not consult ChatGPT or any external adviser for this task.
```

Expected:

```text
no adviser call
```

### Ordinary task under explicit mode

```text
Rename this local variable and update the unit test.
```

Expected:

```text
no adviser call
```

### Adviser failure

Explicit adviser instruction, but simulated adviser outage.

Expected:

```text
one adviser attempt
bounded failure
worker continues locally
no retry loop
```

---

## Suggested release thresholds

For the evaluation suite:

```text
explicit-positive routing:       >= 95%
explicit-negative compliance:    100%
ordinary-task false positives:   <= 5%
correct workflow timing:         >= 90%
failure continuation:            100%
unbounded waits:                  0
```

Run multiple trials where the worker model is stochastic.

---

# 18. Documentation changes

Update:

```text
README.md
docs/getting-started.md
docs/agent-tools.md
docs/configuration.md
docs/architecture-and-safety.md
docs/CONSULTATION_PROTOCOL.md
docs/TROUBLESHOOTING.md
CHANGELOG.md
```

Document prominently:

```text
"Use ChatGPT as adviser"
```

as a supported autonomous-agent workflow.

Example:

```text
# AGENTS.md

For substantial design, debugging, and final review decisions, use ChatGPT as an adviser.
Treat its output as advisory and verify recommendations against repository evidence.
If the adviser is unavailable, continue locally rather than blocking the task.
```

Also document that no special slash command is necessary when the worker is operating autonomously.

---

# 19. Observability

Keep logs useful but low-volume.

Recommended durable diagnostic fields:

```text
consultationId
repository
checkpoint
job state
transport outcome
result status
browser generation
elapsed time
recovery attempted
recovery outcome
circuit state
```

Never log:

```text
cookies
tokens
full browser storage
Pi credentials
private browser identity details
```

For incomplete responses, store partial text only under the same existing adviser-response security rules.

---

# 20. Backward compatibility

Preserve:

```text
/advisor
/advisor-plan
/advisor-review
/advisor-audit
/advisor-debug
/advisor-challenge
...
```

Preserve existing low-level tools.

`advisor_consult` is additive.

Existing configuration should continue loading.

The only deprecated surface should initially be:

```text
autoConsult
```

because its documented semantics were reserved/non-functional.

No repository should suddenly begin proactive adviser use after upgrading.

Default behavior should be:

```text
agentUse.mode = "explicit"
dependencyDefault = "advisory"
advisor_consult mode = "sync"
```

That means:

```text
explicit request → adviser used
no explicit request → no new adviser behavior
adviser failure → local work continues
```

---

# 21. Recommended merge sequence

## PR 1 — `fix: bound adviser browser transactions`

Implement:

* outer transaction deadline;
* abortable transaction wait;
* browser generation invalidation;
* emergency recovery;
* poisoned fail-fast state;
* deadlock regression tests.

Do not begin autonomous routing until this is merged.

---

## PR 2 — `fix: reject incomplete adviser streams`

Implement:

* final completion sentinel;
* completion provenance;
* `incomplete` result handling;
* worker-facing suppression of incomplete advice.

---

## PR 3 — `feat: propagate adviser cancellation and progress`

Implement:

* Pi tool `AbortSignal`;
* progress callbacks;
* runtime progress events;
* cancellation tests.

---

## PR 4 — `feat: add autonomous advisor_consult tool`

Implement:

* semantic high-level tool;
* shared consultation service;
* `promptSnippet`;
* `promptGuidelines`;
* explicit positive/negative tool-use policy;
* `agentUse.mode`;
* compatibility/deprecation handling for `autoConsult`.

At this point:

```text
"Use ChatGPT as adviser"
```

should become a first-class supported workflow.

---

## PR 5 — `feat: complete autonomous adviser delivery`

Implement:

* synchronous agent default;
* supported Pi async session delivery if available;
* reentrancy guards;
* accurate fallback semantics if session injection is unavailable.

---

## PR 6 — `feat: add adviser health circuit breaker`

Implement:

* repeated failure tracking;
* circuit open/half-open behavior;
* fail-fast UX;
* recovery tests.

This PR can be deferred until live testing shows repeated transient failures are materially annoying.

---

# 22. Live canary matrix before release

Run the extension against the real ChatGPT UI for at least:

* normal short consultation;
* long reasoning consultation;
* user cancellation while generating;
* simulated/network-interrupted generation;
* ChatGPT provider error;
* browser tab manually closed;
* Chrome process manually killed;
* signed-out adviser profile;
* human-verification challenge;
* missing/disconnected GitHub connector;
* incomplete/truncated response;
* two queued consultations;
* consultation immediately after forced browser recovery;
* two repositories sharing the process;
* second Pi process contending for the adviser profile;
* explicit autonomous worker instruction;
* trusted `AGENTS.md` adviser instruction;
* explicit "do not use ChatGPT" instruction.

A canary failure must not leave Pi unable to continue local work.

---

# 23. Release gates

Do not release until all of the following are true:

* [ ] A deliberately never-resolving browser operation cannot make a tool call wait indefinitely.
* [ ] A hung transaction cannot permanently block later adviser calls.
* [ ] Unsafe browser recovery results in fail-fast poisoning rather than concurrent tab reuse.
* [ ] Pi tool cancellation reaches the browser consultation.
* [ ] Partial/truncated responses cannot become normal actionable advice.
* [ ] A complete adviser response carries consultation ID, checkpoint provenance, and completion provenance.
* [ ] `advisor_consult` is available as the preferred worker-facing tool.
* [ ] Explicit "use ChatGPT as adviser" prompts reliably cause adviser use in live worker tests.
* [ ] Explicit "do not use ChatGPT" prompts do not cause adviser use.
* [ ] Ordinary tasks do not start consultations under `agentUse.mode="explicit"`.
* [ ] Adviser failure under advisory mode allows the worker to continue.
* [ ] No automatic infinite retries exist.
* [ ] Async mode either delivers safely to the originating worker or is documented accurately as notification-only.
* [ ] Existing slash commands and low-level tools remain compatible.
* [ ] Full unit/integration/typing/lint/Pi smoke suite passes.
* [ ] Real ChatGPT browser canary matrix passes.

---

# 24. Definition of done

After this slice, the intended contract should be simple enough to describe to users as:

> Install `pi-with-chatgpt`, authenticate it once, and tell your Pi agent to "use ChatGPT as adviser." The worker can invoke ChatGPT itself at the requested decision point. ChatGPT remains advisory only. If ChatGPT fails, stalls, disconnects, or becomes unavailable, the adviser operation terminates safely and Pi continues locally rather than hanging.

Internally, the corresponding architecture becomes:

```text
                    ┌─────────────────────────┐
User / AGENTS.md ──►│ Pi worker               │
                    │                         │
                    │ adviser intent policy   │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ advisor_consult         │
                    │ semantic agent API      │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ Consultation service    │
                    │ checkpoint/capability   │
                    │ durable job             │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ Browser supervisor      │
                    │ transaction watchdog    │
                    │ generation/epoch        │
                    │ recovery/poisoning      │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ ChatGPT                 │
                    │ adviser only            │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ Response verification   │
                    │ consultation ID         │
                    │ commit SHA              │
                    │ completion sentinel     │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │ Pi worker               │
                    │ evaluates + executes    │
                    └─────────────────────────┘
```

The priority order is intentional:

```text
first:  make adviser failures impossible to wedge Pi
then:   make returned advice provably complete
then:   make tool cancellation/progress behave correctly
then:   make autonomous invocation easy and reliable
finally: improve async delivery and repeated-failure UX
```

That sequence minimizes the chance that improving autonomous use simply causes the worker to encounter fragile adviser infrastructure more often.
