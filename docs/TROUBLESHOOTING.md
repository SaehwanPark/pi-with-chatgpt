---
layout: default
title: Troubleshooting & FAQs
permalink: /troubleshooting/
---

# Troubleshooting & FAQs

[Home]({{ site.baseurl }}/) | [Getting Started]({{ site.baseurl }}/getting-started/) | [User Guide]({{ site.baseurl }}/user-guide/) | [Agent Tools]({{ site.baseurl }}/agent-tools/) | [Configuration]({{ site.baseurl }}/configuration/) | [Drift]({{ site.baseurl }}/drift-and-disposition/) | [Troubleshooting]({{ site.baseurl }}/troubleshooting/) | [Architecture]({{ site.baseurl }}/architecture-and-safety/)

---

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
2. The extension launches the dedicated, isolated browser window (`~/.pi/agent/pi-with-chatgpt/browser`).
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
- Permissions on `~/.pi/agent/pi-with-chatgpt/browser` grant group or world read/write permissions (INV-11).

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
2. Re-run your consultation command.
3. To test or preflight before submitting, invoke the agent tool:
   `advisor_preflight()`.

---

### 2.3 "GitHub Connector cannot see private repository"
**Symptoms:**
- The adviser reports that it cannot find the repository or cannot read files at the specified commit SHA.

**Cause:**
- The ChatGPT GitHub connector app has not been granted repository access permissions in your GitHub organization or personal account.

**Resolution:**
1. Open ChatGPT in your browser: `https://chatgpt.com`.
2. Go to **Settings** -> **Connected Apps** -> **GitHub**.
3. Ensure the connector is authorized.
4. In GitHub (under **Personal Settings** -> **Applications** -> **Authorized GitHub Apps**), verify that repository permissions are granted for the target repository or organization.

---

## 3. Drift & Stale Advice

### 3.1 Understanding Drift Warnings
When you continue coding after dispatching a consultation, your local `HEAD` moves ahead of the reviewed commit. The extension evaluates the graph distance and file changes:

| Classification | Meaning | Recommended Action |
| --- | --- | --- |
| `current` | `HEAD` is exactly at the reviewed checkpoint SHA. | Apply advice directly. |
| `likely_applicable` | `HEAD` has advanced slightly, but no mentioned files were modified. | Safe to apply advice. |
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

## 5. Frequently Asked Questions (FAQs)

### Q1: Does ChatGPT have write access to my git repository?
**No.** The adviser operates strictly as read-only. In V1, the extension has zero git write authority: it never runs `git add`, `git commit`, `git push`, or any mutating git command (INV-06). Pi and the user remain the sole execution authorities.

### Q2: Are my repository files uploaded to OpenAI servers through the extension?
**No.** `pi-with-chatgpt` never bundles, zips, or uploads local files. Context travels exclusively through GitHub via the official ChatGPT GitHub Connector app (INV-02).

### Q3: Can I use this with private repositories?
**Yes.** As long as you grant the ChatGPT GitHub Connector app read access to your private repository in GitHub's application settings.

### Q4: Which ChatGPT models are used for consultations?
The extension uses the model associated with your active ChatGPT session (such as OpenAI o1, o3-mini, or GPT-4o). You can select your preferred default model in the ChatGPT Project settings.
