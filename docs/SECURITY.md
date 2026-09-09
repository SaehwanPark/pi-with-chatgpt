# SECURITY.md — Security Contract and Threat Model

This is the security authority for `pi-with-chatgpt`. It states what the extension refuses to
make possible, which invariants enforce it, and where each is enforced in code. The full invariant
prose is [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

## Trust boundaries

| Boundary | What crosses it | What never crosses it |
| --- | --- | --- |
| Pi worker model → extension | A consultation request (question, mode, dependency) | Credentials, browser state, job machinery internals |
| ChatGPT → Pi | An advisory report (markdown + action items) | Executable authority, tool results, git/merge authority |
| Browser → disk | Session state inside the extension-owned profile | Cookies/tokens into logs, telemetry, git, or model context |
| Git → repository | Explicit, staged, user-authorised commits | `git add -A`, auto-push, merge, force-push, token disclosure |
| Repository → ChatGPT | Nothing directly; only what is visible on GitHub | Archives, file uploads, tunnels, workspace bridges |

## Invariants that are security properties

| ID | Property | Enforced by |
| --- | --- | --- |
| INV-02 | No non-GitHub source transport | `protocol/context-channel.ts` (closed union), `protocol/repo.ts` (host allowlist), `git/authority.test.ts` (prohibited-path source scan) |
| INV-08 | Canonical repository identity from remote inspection, never a config override | `protocol/repo.ts` |
| INV-09 | Adviser output is untrusted and cannot carry capability | `protocol/trust.ts` (`AdviserOutput`, `WorkerDecision`, no execution field) |
| INV-10 | No local upload path exists even when misconfigured | `protocol/context-channel.ts` |
| INV-13 | Worker sees only a purpose-built advice surface | `ui/worker-facing.ts` (allowlist projection + forbidden-key assertion) |
| INV-15 | Credential material never enters logs, model context, git, or telemetry | `auth/identity.ts`, `browser/profile.ts`, `config/schema.ts` (config rejects credential fields), `ledger/record.ts` (`assertCredentialFree` before persistence) |
| INV-16 | One Project per canonical repository key | `chatgpt/scope.ts` |
| INV-05 | Isolated, extension-owned browser profile only | `browser/profile.ts` (`validateProfileDir`) |

## Credential containment

- **Identity discovery (M2)** reads the OpenAI/Codex identity from the Pi auth store
  (`~/.pi/agent/auth.json`) to recognise *which* account the browser session should belong to. That
  file is read with `0o600`-only expectations, and its contents are never copied into a log line, an
  error message, a ledger record, or a worker-facing message.
- **Tokens are never an input** to any module in this repository. `AuthIdentity` carries an `email`
  and a `source` label only (`auth/identity.ts`).
- **Config cannot carry credentials** (`config/schema.ts`); a future user who pastes a token into a
  settings file gets a validation error, not a working credential path.
- **Ledger records are scanned** for bearer-token shapes, PEM blocks, and long base64 secrets before
  they are persisted (`ledger/record.ts`), because the ledger is the one artifact that accumulates
  raw adviser text.

## Prompt injection posture

Repository content is untrusted input to the adviser, and adviser output is untrusted input to the
worker. The extension never instructs the worker to treat advice as authoritative, never executes
commands embedded in advice, and never follows URLs from advice except to report them. Action items
are data with stable IDs and a disposition; they are not instructions.

## What V1 does not do

- No secret scanning, signing, or attestation pipeline (post-V1 backlog).
- No multi-user or shared-machine isolation beyond file permissions on the profile and state
  directories.
- No Windows-specific security claims (platform is deferred to post-V1).

## Reporting

Report vulnerabilities through the repository's private security channel. Include the extension
version (`package.json`), the Pi version, the OS, and the reproduction steps — never your ChatGPT
session state, cookies, or tokens.
