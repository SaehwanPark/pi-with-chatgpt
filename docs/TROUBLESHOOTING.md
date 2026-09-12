# Troubleshooting Guide: pi-with-chatgpt

This guide covers common operational questions, error codes, and recovery procedures for `pi-with-chatgpt`.

---

## 1. Authentication & Browser Issues

### 1.1 "ChatGPT adviser sign-in required"
**Symptoms:**
- Slash commands or tools report that the adviser is not authenticated.
- TUI notification: `ChatGPT adviser sign-in required (no-openai-sign-in)` or `(session-expired)`.

**Cause:**
- Pi has not discovered an OpenAI OAuth credential in `auth.json`, or the session cookies in the extension's dedicated browser profile have expired.

**Resolution:**
1. Run `/advisor-auth` in Pi.
2. If interactive browser support is enabled, this opens the dedicated, isolated browser window (`~/.pi/agent/pi-with-chatgpt/browser`).
3. Complete the ChatGPT login manually in the window.
4. Once completed, close the browser window or let the probe detect authentication.
5. Alternatively, run `pi auth login --provider openai-codex` so Pi can store the primary OpenAI identity.

---

### 1.2 "Human verification challenge / CAPTCHA required"
**Symptoms:**
- The consultation fails with status `human-verification`.

**Cause:**
- Cloudflare, Arkose, or ChatGPT presented an interactive verification gate (CAPTCHA or 2FA) that automated Playwright cannot and must not solve (INV-09).

**Resolution:**
1. The extension automatically halts Playwright automation upon detecting a human challenge.
2. Run `/advisor-auth` to open the isolated browser profile manually.
3. Solve the CAPTCHA and complete any 2FA challenge in the browser window.
4. Verify you reach `https://chatgpt.com/` and are logged in.
5. Close the browser and re-run your consultation.

---

### 1.3 State Directory Permissions Refusal (`StateStorageError: directory-not-private`)
**Symptoms:**
- Extension startup or command fails with:
  `StateStorageError: refusing to use state directory ... mode grants access to others`.

**Cause:**
- Permissions on `~/.pi/agent/pi-with-chatgpt/browser` grant group or other read/write permissions (INV-11).

**Resolution:**
Run the following command in your terminal to restrict permissions to the owner only:
```bash
chmod -R 0700 ~/.pi/agent/pi-with-chatgpt
```

---

## 2. Git & GitHub Checkpoint Issues

### 2.1 "Checkpoint refusal (remote-unreachable)"
**Symptoms:**
- `/advisor` or `advisor_submit` reports:
  `Checkpoint refusal (remote-unreachable): Remote origin is not reachable or requires authentication.`

**Cause:**
- Git remote URL is unreachable, offline, or GitHub credentials for `git ls-remote` are missing.

**Resolution:**
1. Check your network connectivity.
2. Verify you can access the remote repository manually:
   ```bash
   git ls-remote origin
   ```
3. If using an SSH remote, ensure your SSH agent is running (`ssh-add -l`).
4. If using an HTTPS remote, ensure your GitHub token (`GH_TOKEN` or `GITHUB_TOKEN`) is set or your credential helper is configured.

---

### 2.2 "Checkpoint refusal (missing-commit)" / "Commit not pushed"
**Symptoms:**
- `/advisor` reports:
  `Checkpoint refusal (missing-commit): Commit <sha> is not reachable on remote origin.`

**Cause:**
- You have made local commits that have not yet been pushed to GitHub (INV-03, INV-04). Since ChatGPT accesses code exclusively through GitHub, it cannot review commits that only exist on your local disk.

**Resolution:**
1. Push your branch to the configured GitHub remote:
   ```bash
   git push -u origin <branch-name>
   ```
2. Re-run `/advisor`.
3. To test or preflight before submitting, invoke the agent tool:
   `advisor_preflight(ref: "HEAD")`.

---

### 2.3 "GitHub Connector cannot see private repository"
**Symptoms:**
- The adviser reports that it cannot find the repository or cannot read files at the specified commit SHA.

**Cause:**
- The ChatGPT GitHub connector app has not been granted repository access permissions in your GitHub organization or account.

**Resolution:**
1. Open ChatGPT in your browser: `https://chatgpt.com`.
2. Go to **Settings** -> **Connected Apps** -> **GitHub**.
3. Ensure the connector is authorized.
4. In GitHub (under **Personal Settings** -> **Applications** -> **Authorized OAuth Apps** / **GitHub Apps**), verify that repository permissions are granted for the target repository or organization.

---

## 3. Drift & Stale Advice

### 3.1 Understanding Drift Classification
When you continue coding after dispatching a consultation, your local HEAD moves ahead of the reviewed commit. The extension evaluates the graph distance and file changes:

| Classification | Meaning | Worker Recommendation |
| --- | --- | --- |
| `current` | HEAD is exactly at the reviewed checkpoint SHA. | Apply advice directly. |
| `likely_applicable` | HEAD has advanced slightly (e.g. 1–3 commits), but no mentioned files were modified. | Safe to apply advice. |
| `materially_stale` | Files mentioned in the adviser's recommendations were modified in subsequent commits. | Review changes before applying. |
| `needs_reconsultation` | History diverged (e.g. rebase/force-push) or large structural changes occurred. | Dispatch a follow-up via `/advisor-followup`. |
| `provenance_degraded` | Commit SHA missing from local or remote history. | Re-anchor to current HEAD. |

Check drift at any time using `/advisor-status` or the agent tool `advisor_status()`.

---

## 4. Consultation Failure & Degradation

### 4.1 "Advisory failure (non-blocking)"
**Symptoms:**
- You see a warning notification such as:
  `[advisor:review] Advisory consultation failed (rate-limited): provider rate limit reached. Proceeding with local Pi worker.`

**Behavior:**
- Under default configuration (`dependencyDefault: "advisory"`), adviser failure **never blocks local Pi development** (INV-07).
- Pi continues executing tasks using its local worker model.

**If you want strict blocking:**
- Configure `"dependencyDefault": "required"` in `~/.pi/agent/settings.json`.
- When set to `required`, adviser failure halts execution (`blocked: true`) until resolved.

---

## 5. Configuration Reference

Configuration can be placed in your Pi global settings (`~/.pi/agent/settings.json`) or passed when loading the extension.

```json
{
  "pi-with-chatgpt": {
    "dependencyDefault": "advisory",
    "defaultMode": "sync",
    "syncTimeoutMs": 240000,
    "pollIntervalMs": 5000,
    "autoConsult": {
      "enabled": false,
      "confirmBeforeDispatch": true
    },
    "browserExecutablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "logLevel": "info"
  }
}
```

### Configuration Keys:
- `dependencyDefault` (`"advisory"` | `"required"`, default: `"advisory"`):
  Controls whether a failure to consult the adviser blocks the Pi worker.
- `defaultMode` (`"sync"` | `"async"`, default: `"sync"`):
  Determines whether consultations wait for turn completion synchronously or run in the background.
- `syncTimeoutMs` (number, default: `240000`):
  Maximum time (in milliseconds) to wait for a synchronous consultation turn.
- `pollIntervalMs` (number, default: `5000`):
  Polling cadence for asynchronous consultation jobs.
- `autoConsult.enabled` (boolean, default: `false`):
  When enabled, Pi may propose auto-consultation on high-value semantic triggers (e.g. major architectural refactor, security changes).
- `autoConsult.confirmBeforeDispatch` (boolean, default: `true`):
  Prompts the user before dispatching an auto-consultation.
- `browserExecutablePath` (string, optional):
  Explicit path to a system Google Chrome or Chromium executable. Never points to user profile directory.
- `logLevel` (`"silent"` | `"info"` | `"verbose"`, default: `"info"`):
  Logging verbosity for diagnostic information.
