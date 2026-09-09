# Architecture Invariants (INV-01 … INV-16)

Canonical review checklist for `pwc-invariant-review`. `source` points at the authoritative
text; when this table and the docs disagree, the docs win and this file is the bug.

| ID | Invariant | Source | Review probe |
| --- | --- | --- | --- |
| INV-01 | **No execution ownership.** ChatGPT never edits, executes, commits, pushes, or orchestrates Pi. | PROPOSAL §1, §5.1 | Any code path where adviser text reaches a shell, editor, git, or scheduler call without an explicit worker/user decision |
| INV-02 | **GitHub-only context in V1.** No archives, uploads, tunnels, workspace bridge, or local log/screenshot/diagnostic attachment. | PROPOSAL §4, §21 | New transport: file read + send, zip, base64 blob, paste-a-file helper, attachment field |
| INV-03 | **Immutable anchor.** Every consultation resolves to a full commit SHA; `requestedRef` is stored separately; never silently retargeted. | PROPOSAL §8.1, §8.4 | Short SHA, branch name, `HEAD`, or tag used as the anchor; in-place mutation of `resolvedCommit` |
| INV-04 | **Remote reachability precedes dispatch.** The resolved SHA must be verified reachable on the *selected* GitHub remote; otherwise return a structured "checkpoint not remote". | PROPOSAL §8.2 | Dispatch gated on branch existence rather than object reachability; silent dispatch that the adviser cannot inspect |
| INV-05 | **Advice is untrusted, non-authoritative input**, subordinate to current code, tests, project constraints, and user instructions. Repository content is explicitly untrusted to the adviser too. | PROPOSAL §13, §24.5 | Auto-applied action items; adviser output as a privileged trigger; injected repo text treated as instruction |
| INV-06 | **A consultation implies no git authority.** No `git add -A`, no auto-commit, no auto-push; a remote named `origin` is not authorisation; ignored/untracked files stay untouched. | PROPOSAL §20, ROADMAP M9 | Commit/push calls on the adviser dispatch path; broad staging helpers |
| INV-07 | **Adviser failure is non-blocking by default** (`dependency: advisory`); blocking is explicit. | PROPOSAL §5.7, §11.3 | `await` on adviser result in a path with no advisory/required distinction; errors that halt local work |
| INV-08 | **One ChatGPT Project per GitHub repository**, keyed by stable repo identity, persisted, reused, race-safe. | PROPOSAL §7, ROADMAP M4 | Project created per session/task/branch; unguarded create path under concurrency |
| INV-09 | **Task conversation isolation.** Unrelated tasks use separate conversations; writes to one conversation are serialised; no cross-delivery between repos, tasks, or Pi sessions. | PROPOSAL §22, ROADMAP M9 | Shared thread for unrelated kinds; delivery keyed on something other than job/session/task id |
| INV-10 | **Account identity stability.** Never silently switch OpenAI/ChatGPT accounts; mismatch is an explicit user decision. | PROPOSAL §16.5 | Fallback that picks "any available" session; account chosen by profile scan order |
| INV-11 | **Isolated, extension-owned browser runtime.** Never automate the user's active browser for normal jobs; never hijack a global browser tool or another extension's state. | PROPOSAL §17, §25 | Reuse of the user profile; global browser singleton; default-profile CDP attach |
| INV-12 | **Credential containment.** No cookies, tokens, OAuth material, or session identifiers in logs, ledger records, tool output, or model context; state dir permissions restricted; no routine plaintext cookie export. | PROPOSAL §24.2, ROADMAP M9 | Verbose logging of headers/profile paths; ledger storing raw auth state; browser state inside the repo |
| INV-13 | **Worker-opaque machinery.** The worker gets structured adviser primitives, not DOM, polling, OAuth, or job-directory knowledge; verbose internals stay out of the user transcript. | PROPOSAL §17, ROADMAP M8 | Tool descriptions or results that teach ChatGPT UI control; raw browser dumps in transcript |
| INV-14 | **Trust order.** Code at requested commit > consultation brief > task conversation history > Project instructions > Project memory. | PROPOSAL §7 | Project instructions that embed mutable branch/commit values; memory used as a provenance substitute |
| INV-15 | **Durable provenance outside model context.** Persist the job before submission and the result before wake-up; ledger is local, append-oriented, and never automatically a repo file, issue, or PR comment. | PROPOSAL §18, ROADMAP M5/M6 | Result only in memory; wake-up before persistence; auto-publish of advice |
| INV-16 | **V1 scope guard.** No non-GitHub hosts, no extra adviser providers, no publish-to-PR by default; post-V1 features stay additive and never fork the core protocol. | PROPOSAL §4, §29, ROADMAP post-V1 | Provider abstraction that assumes a second transport; feature flags that relax INV-01…INV-15 |

## Cross-cutting review probes

- **Race and recovery**: every new shared resource (conversation, job record, ledger file,
  browser session, Project mapping) states its owner and its serialisation or isolation.
- **Failure vocabulary**: new failures map to a state, a worker-visible result, and a user
  recovery path (see `pwc-adviser-runtime/references/failure-matrix.md`).
- **Evidence discipline**: exit-criteria claims cite a test name or artifact, not intent.
- **Doc sync**: contract changes update `CHECKPOINT_PROTOCOL.md`, `CONSULTATION_PROTOCOL.md`,
  `AUTHENTICATION.md`, `SECURITY.md`, `AGENTS.md`, and `CHANGELOG.md` in the same change.

## Prohibited-by-construction patterns

```text
git add -A                      adviser output -> shell/edit/commit/push
advisory await that blocks      sendDir / archive / upload / attach
branch name as anchor           mutate resolvedCommit after dispatch
default-profile browser         cookie/profile path in a log line
"paste the file and I'll…“      Project per session/task/branch
```

Each of these should be unreachable by construction (type or module boundary) or rejected by a
test, not merely discouraged in review.
