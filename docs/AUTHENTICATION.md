# Authentication

How the adviser signs in to ChatGPT, where that state lives, and why it never touches the worker side.
Companion invariants: `docs/SECURITY.md`; code: `auth/`, `browser/`.

## The two identities

| | Worker | Adviser |
| --- | --- | --- |
| What runs | the Pi session (any provider: Ollama/Qwen, OpenRouter, API key, …) | ChatGPT in an isolated Chrome |
| Credential | whatever Pi is configured with | Pi's stored **OpenAI OAuth** sign-in |
| Compared | only to confirm it is *not* the adviser's source | resolved to an account hint for the mismatch check |

The adviser's account comes from Pi's OpenAI sign-in; the worker's provider and model are never
consulted (`auth/worker-independence.ts`). A local worker with no OpenAI model of its own is the normal
case, not a special one. The rule exists to stop two accidents: gating the adviser on the worker's
provider (which would disable it for exactly the users it exists for) and reusing a worker **API key**
as an assumed ChatGPT account (an API key carries no account, so it resolves to *no* identity — see
`auth/pi-credential.ts`).

## Credential discovery

1. **Preferred** — Pi's own `AuthStorage.getAuth("openai-codex")`, resolved through the installed
   `@earendil-works/pi-coding-agent` package, so the on-disk format stays Pi's private concern and this
   extension never parses its internals.
2. **Fallback** — direct read of `${PI_CODING_AGENT_DIR:-~/.pi/agent}/auth.json` when the package is
   not resolvable (a future layout change surfaces as a visible "not signed in" rather than a crash).

What is read out of the stored credential: the **access-token JWT claims** (`accountId`, plan type,
email, expiry) and nothing else. The refresh token is dropped at parse time; the access token is handed
to the resolver as a `SecretText` and zeroed once its claims are extracted
(`auth/secret-text.ts`). Codex access tokens nest their claims under `https://api.openai.com/auth`;
flat dotted keys are accepted too, because a mismatch here reads as "not signed in".

Account ids and emails are treated as **hints**, never facts: an approximate hash is stored, masked for
display (`alice@` → `a***@`), and the comparison only ever *blocks* on a demonstrated mismatch. An
unidentified side is reported as unknown, because a mismatch prompt that fires on every session trains
people to click through it.

## State location and permissions

| Path | Contents | Mode |
| --- | --- | --- |
| `~/.pi/agent/pi-with-chatgpt/browser/` | profile root | `0700` |
| `…/browser/chatgpt-profile/` | the extension-owned Chrome `user-data-dir` | `0700` |
| `…/browser/capability.json` | last capability probe | `0600` |
| `…/browser/chrome-state-import.json` | import provenance (no identity detail) | `0600` |
| `…/browser/imported/` | staging copy before it becomes the profile | `0700` |
| `…/browser/profile.lock` | single-writer lock | `0600` |
| `<repo>/.chatgpt-adviser/OWNERSHIP` | marker claiming a project-local dir | `0600` |

Root creation uses a **create-exclusive + `O_NOFOLLOW` open + ownership marker** sequence: a planted
symlink at an expected path gets an `EPERM` instead of a redirected write, and a directory that exists
without our marker is refused rather than adopted. Ownership is proven by the marker, never by a name.

## Importing an existing sign-in (Chrome state)

Import is a **file copy, not a decryption**. Chromium encrypts cookie values with an OS key (macOS
Keychain, Linux libsecret); the copy inherits that protection and the real browser decrypts it at
runtime. So this extension never holds a key and never derives one — there is no decryption path to
get wrong (`browser/cookie-import.ts`).

The copy is allow-listed to the minimum: `Default/Network/Cookies` (+ `-wal`, `-shm`) and `Local State`
(which carries the decryption key reference, not key material). Browser metadata is parsed read-only
from plaintext JSON (`Local State`, `Preferences`) for account hints only.

Import is **refused**, not warned, when:

- the source browser is running (a live cookie DB copies as a torn database — an expired session at an
  arbitrary future date, with no error anywhere);
- the destination already contains a profile (implicit overwrite destroys a sign-in the user made
  interactively);
- source and destination are the same directory (the "discard import" path would then delete a real
  browser profile);
- any requested path escapes the profile root.

`verifyChromeStateImport` checks file sizes and SQLite magic bytes — enough to prove a usable database
arrived, without reading a cookie.

## Manual sign-in

When import is unavailable or unwanted, `auth/login-flow.ts` opens the adviser window and waits. The
port it uses (`AdviserLoginPort`) has **no click, type, navigate, or solve method**, so automating the
login is structurally impossible rather than merely discouraged. A `human-verification` observation is
terminal: waiting a CAPTCHA out is automating it by omission. On success the profile is sealed *before*
success is reported (an unflushed profile returns logged out, which is the bug this path exists to
prevent), and a `SESSION-ESTABLISHED` marker records that a sign-in once happened — a file that proves
neither when nor that the session is still valid.

## Capability checklist

Run before the first consultation, cached briefly, invalidated by anything that could change the answer
(sign-in completed, Chrome state imported, authentication failed, model list changed) rather than by
age alone:

1. ChatGPT access 2. adviser model available 3. GitHub connector 4. target repository visible

Only the first two plus the repository checkpoint block a consultation. An **unverified** check is
distinct from a failed one: "we have not looked" must not be reported as "it is broken", and it never
dispatches a consultation. See `browser/capability-checks.ts`.

## Platform support

| Platform | Sign-in reuse | Notes |
| --- | --- | --- |
| macOS | Yes (Chrome, Chromium, Brave, Edge) | validated in CI |
| Linux | Yes (Chrome, Chromium, Brave, Edge) | validated locally; keychain-backed decryption needs a running keyring service |
| Windows | **Out of V1 scope** | no Chromium state paths are guessed; the detection function returns an empty list, so the flow offers manual sign-in and never asks the user to type a cookie path |

## Troubleshooting

| Symptom | Cause | Do |
| --- | --- | --- |
| `source-browser-running` | Chrome is using the profile you tried to import | close Chrome fully, then retry |
| `destination-not-empty` | a profile already exists | use **Repair sign-in**, or delete `…/browser/chatgpt-profile` deliberately |
| `refuses-path-outside-state-root` | path traversal attempt | report it; do not work around it |
| account mismatch prompt | worker and adviser resolved to different accounts | choose **keep-current** or **reauthenticate**; **skip-adviser** degrades to local-only work |
| signed out after a working import | source cookie DB was copied live | re-import with the browser closed, or sign in manually |

## Reset

Delete the state root to return to a clean slate; nothing outside it is touched:

```bash
rm -rf ~/.pi/agent/pi-with-chatgpt/browser
```

The repository-side companion directory is removed by the normal `git clean` discipline documented in
`docs/CHECKPOINT_PROTOCOL.md`. No credential or cookie ever lives in either location.
