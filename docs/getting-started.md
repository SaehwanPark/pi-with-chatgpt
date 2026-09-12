---
layout: default
title: Getting Started
permalink: /getting-started/
---

# Getting Started with pi-with-chatgpt

[Home]({{ site.baseurl }}/) | [Getting Started]({{ site.baseurl }}/getting-started/) | [User Guide]({{ site.baseurl }}/user-guide/) | [Agent Tools]({{ site.baseurl }}/agent-tools/) | [Configuration]({{ site.baseurl }}/configuration/) | [Drift]({{ site.baseurl }}/drift-and-disposition/) | [Troubleshooting]({{ site.baseurl }}/troubleshooting/) | [Architecture]({{ site.baseurl }}/architecture-and-safety/)

---

Welcome to `pi-with-chatgpt`. This guide will take you from zero to your first consultation with a senior ChatGPT reasoning model advising your Pi worker agent.

---

## 1. System Requirements & Prerequisites

Before installing the extension, ensure you have the following prerequisites configured on your system:

| Prerequisite | Minimum Version / Requirement | Notes |
| --- | --- | --- |
| **Operating System** | macOS or Linux | Windows is planned for post-V1. |
| **Node.js** | `>= 22.19.0` | Node 22 LTS is recommended. |
| **Pi Coding Agent** | `>= 0.85.0` | Installed globally via `@earendil-works/pi-coding-agent`. |
| **Google Chrome / Chromium** | Recent stable release | Used by the extension's dedicated Playwright profile. |
| **Git & GitHub** | Active GitHub repository | The remote repository must be hosted on GitHub. |
| **ChatGPT Account** | Free, Plus, Pro, or Team | With GitHub Connector app authorized. |

---

## 2. Installation

### Method A: Direct Install via Pi (Recommended)

You can install `pi-with-chatgpt` directly into your global Pi installation using Pi's package manager:

```bash
pi install git:github.com/SaehwanPark/pi-with-chatgpt
```

Pi will clone the package, build the distribution artifacts, and register the extension in your Pi configuration.

### Method B: Development / Local Extension Flag

If you cloned this repository locally or want to contribute to development:

```bash
git clone https://github.com/SaehwanPark/pi-with-chatgpt.git
cd pi-with-chatgpt
npm ci
npm run build
```

Then start Pi pointing to your local build:

```bash
pi -e /path/to/pi-with-chatgpt
```

---

## 3. First-Time Setup & Authentication

`pi-with-chatgpt` maintains an **isolated, dedicated browser profile** (`~/.pi/agent/pi-with-chatgpt/browser`) locked to owner-only permissions (`0700`). Your day-to-day personal browser profile is never touched.

### Step 1: Open Pi in your Git repository

Navigate to your git repository and launch Pi:

```bash
cd ~/my-project
pi
```

> [!IMPORTANT]
> The git repository must have a configured GitHub remote (e.g. `origin` pointing to `https://github.com/username/repo` or `git@github.com:username/repo.git`).

### Step 2: Check or Initiate Authentication

In the Pi interactive prompt, run:

```text
/advisor-auth
```

The extension inspects authentication in order:
1. **Existing Pi OpenAI Identity**: If you previously configured an OpenAI key or session via Pi (`pi auth login --provider openai-codex`), the extension discovers it.
2. **Dedicated Profile Session**: If session cookies already exist in `~/.pi/agent/pi-with-chatgpt/browser`, it verifies their validity.
3. **Interactive Login Window**: If sign-in is required, the extension launches a visible Chrome browser window using the isolated profile.

### Step 3: Complete Sign-In in the Browser

When the isolated browser window appears:
1. Sign in to your ChatGPT account (via Google, Microsoft, Apple, or email/password).
2. Complete any Multi-Factor Authentication (MFA) or human verification challenges (Cloudflare / Arkose CAPTCHA).
3. Once you arrive at the ChatGPT home interface (`https://chatgpt.com`), close the browser window or let Pi detect that the session is active.

### Step 4: Authorize the ChatGPT GitHub Connector

ChatGPT accesses your code **exclusively through the official GitHub connector app**:

1. In ChatGPT (`https://chatgpt.com`), navigate to **Settings** -> **Connected Apps** -> **GitHub**.
2. Verify that the GitHub app has access to the repository you are working on.
3. For private repositories or enterprise organizations, ensure repository read access has been granted under your GitHub account's **Authorized GitHub Apps** settings.

---

## 4. Running Your First Consultation

`pi-with-chatgpt` anchors every consultation to an **immutable git commit SHA** that has been pushed to GitHub. This ensures the adviser reviews exact, verified code without uploading local files or uncommitted diffs.

### Step 1: Commit and Push Your Changes

Ensure your local changes are committed and pushed to GitHub:

```bash
git add src/
git commit -m "feat: implement user session management"
git push -u origin main
```

### Step 2: Request an Architectural Plan or Code Review

In your Pi session, ask your senior adviser for a review:

```text
/advisor-review Focus on session token rotation and edge cases in token expiry.
```

Or ask for an implementation plan before writing complex code:

```text
/advisor-plan How should we implement distributed rate limiting using Redis?
```

### Step 3: Observe the Consultation Lifecycle

Pi will display a progress notification:

```text
[advisor:review] dispatching adv-3f8a-1 (owner/repo@a4b91c0, sync)
Pi may continue working while the consultation runs.
```

- **In Synchronous Mode (`sync`)**: Pi waits for the adviser to finish, then renders the full advice directly in your terminal.
- **In Asynchronous Mode (`async`)**: Pi returns control to you immediately. You can check progress anytime with `/advisor-status` and read completed advice with `/advisor-read`.

---

## 5. What Happens Next: Drift & Disposition

While the adviser was thinking, did you commit more code? No problem!

`pi-with-chatgpt` tracks **dual cursors**:
1. **Adviser Checkpoint**: The exact commit reviewed by ChatGPT (e.g. `a4b91c0`).
2. **Current Development Cursor**: Your current `HEAD` (e.g. `e8d2f04`, 2 commits ahead).

When the advice lands, run `/advisor-status` to inspect drift:
- If files touched by the advice were not changed locally, the drift is classified as `likely_applicable`.
- If advice touched files that you've modified since the consultation, it's flagged as `materially_stale`, alerting you to review the changes carefully.

Each piece of advice includes structured action items (`A1`, `A2`, etc.). Your local Pi worker model or you can disposition them as `implemented`, `rejected_with_reason`, or `superseded` using the agent tool `advisor_disposition`.

---

## 6. Next Steps

- Explore all 11 user commands in the [**User Guide (Slash Commands)**](./user-guide).
- Learn how Pi workers use tools automatically in the [**Agent Tools Reference**](./agent-tools).
- Customize timeouts, auto-consultation, and browser paths in the [**Configuration Guide**](./configuration).
- Review safety principles and invariants in [**Architecture & Invariants**](./architecture-and-safety).
