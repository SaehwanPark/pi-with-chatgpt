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
| INV-02 | No non-GitHub source transport in V1 | `protocol/context-channel.ts` (`V1_CONTEXT_CHANNELS === ["github"]`), `protocol/repo.ts` (`supportedGitHubHosts`, `credentials-in-url` rejection), `git/authority.test.ts` (prohibited-path source scan) |
| INV-05 | Adviser output is untrusted, non-authoritative input | `protocol/trust.ts` (`AdviserText` provenance brand, `assertNotAdviserAuthored`, `ApprovedAction` requires a `WorkerDecision`) |
| INV-06 | A consultation implies no git authority | `git/authority.ts` (`READ_ONLY_GIT_INVOCATIONS` allowlist, `FORBIDDEN_GIT_ARG_TOKENS` incl. file-write/exec arguments such as `--output`, `--ext-diff`, `--upload-pack`, `-c`) |
| INV-08 | One Project per canonical repository identity | `protocol/repo.ts` (`canonicalRepositoryKey`) + `chatgpt/scope.ts` (`projectKeyForRepository`) |
| INV-10 | No silent OpenAI/ChatGPT account switch | `auth/identity.ts` (`compareAccountIdentity`, `resolveAccountMismatch` — only `continue-with-user-approval` resolves a mismatch) |
| INV-11 | Isolated, extension-owned browser runtime | `browser/profile.ts` (`createAdviserProfile`, `isLikelyUserBrowserProfile`, `ProfileOwnershipError`) |
| INV-12 | Credentials never enter logs, ledger, config, or model context | `config/schema.ts` (`FORBIDDEN_CONFIG_KEYS`), `ledger/record.ts` (`assertLedgerRecordSafe` with `SENSITIVE_LEDGER_KEY_PATTERN` / `SENSITIVE_VALUE_PATTERNS`) |
| INV-13 | Worker sees only a purpose-built advice surface | `ui/worker-facing.ts` (`toWorkerFacingAdvisory` projection, `WORKER_FACING_FORBIDDEN_KEY_PATTERN`) |
| INV-15 | Provenance persists before dispatch and before wake-up, and is never auto-published | `ledger/record.ts` (`assertPersistenceOrder`, `LEDGER_PUBLICATION_TARGETS === ["none"]`) |

The canonical statement of each invariant is
[`references/invariants.md`](../.agents/skills/pwc-invariant-review/references/invariants.md);
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) is the prose authority and `protocol/invariants.ts` is the
machine-readable index.

## Credential containment

- **Identity discovery (delivered in M2)** will read the OpenAI/Codex identity from the Pi auth store
  to recognise *which* account the adviser browser session should belong to. The M0 contract in
  `auth/identity.ts` is deliberately limited to an email hint plus a source label: there is no field
  in which a token can be carried, and a mismatch can only be resolved by explicit user approval.
- **Tokens are never an input** to any module in this repository. No function in `auth/`, `browser/`,
  `chatgpt/`, `jobs/`, `ledger/`, or `protocol/` accepts one.
- **Config cannot carry credentials**: `parseAdviserConfig` rejects every credential-shaped key
  instead of ignoring it, and rejects keys that would redirect the browser profile or state root.
- **A credential-bearing remote URL is refused**, not silently canonicalised:
  `parseGitHubRemote("https://user:token@github.com/o/r")` returns `credentials-in-url`, because a URL
  that contains a secret must never become a repository key or a log line (INV-12).
- **Ledger records are scanned** before persistence (`assertLedgerRecordSafe`) for credential-shaped
  keys and for these value shapes: `Bearer …`, GitHub PAT prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`,
  `ghr_`, `github_pat_`), `sk-` provider keys, `Cookie:`/`Set-Cookie:` headers, and PEM private-key
  blocks. Generic high-entropy/base64 detection is deliberately **not** used: raw adviser prose is
  stored in the same record, and a heuristic that rejects base64 would reject legitimate advice rather
  than protect it. The scan is an additional tripwire, not the primary design — the primary design is
  that session material has nowhere to be written.

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
