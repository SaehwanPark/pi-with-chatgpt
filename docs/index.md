---
layout: default
title: Home
---

# pi-with-chatgpt

> **ChatGPT advises. Pi decides and executes.**

`pi-with-chatgpt` is a high-assurance [Pi](https://github.com/badlogic/pi-mono) extension that allows an inexpensive or local Pi worker model (such as Qwen 2.5 Coder via Ollama, local models via vLLM, or smaller cloud models like `gpt-4o-mini` / `claude-3-5-haiku`) to consult a frontier ChatGPT reasoning model as an external **senior adviser**.

ChatGPT provides architectural planning, code reviews, adversarial security audits, complex debugging root-cause analyses, and design challenge evaluations — while Pi remains the sole owner of edits, shells, tests, and git operations.

---

[Home]({{ site.baseurl }}/) | [Getting Started]({{ site.baseurl }}/getting-started/) | [User Guide]({{ site.baseurl }}/user-guide/) | [Agent Tools]({{ site.baseurl }}/agent-tools/) | [Configuration]({{ site.baseurl }}/configuration/) | [Drift]({{ site.baseurl }}/drift-and-disposition/) | [Troubleshooting]({{ site.baseurl }}/troubleshooting/) | [Architecture]({{ site.baseurl }}/architecture-and-safety/)

---

## Documentation Quick Links

| Guide | Description |
| --- | --- |
| [**Getting Started**]({{ site.baseurl }}/getting-started/) | Installation, prerequisites, and first-time setup guide. |
| [**User Guide (Slash Commands)**]({{ site.baseurl }}/user-guide/) | Comprehensive guide to all 11 user-facing slash commands. |
| [**Agent Tools Reference**]({{ site.baseurl }}/agent-tools/) | Technical reference for the 8 agent-facing tools used by Pi workers. |
| [**Configuration Guide**]({{ site.baseurl }}/configuration/) | Settings, options, auto-consultation policies, and environment variables. |
| [**Drift & Disposition Guide**]({{ site.baseurl }}/drift-and-disposition/) | How dual cursors work, the 5 drift tiers, and action-item tracking. |
| [**Troubleshooting & FAQs**]({{ site.baseurl }}/troubleshooting/) | Resolving authentication, CAPTCHAs, permissions, and git errors. |
| [**Architecture & Invariants**]({{ site.baseurl }}/architecture-and-safety/) | Architectural invariants, security model, and privacy guarantees. |

---

## The Core Philosophy: An Asymmetric Relationship

In modern agentic workflows, compute requirements are fundamentally asymmetric:

- **Routine implementation** (generating tests, editing files, formatting code, running unit tests) is best suited for inexpensive, high-speed, or local worker models.
- **Critical decision points** (architecture transitions, migration schemas, security audits, race-condition root causes) benefit from frontier reasoning models.

Instead of burning expensive frontier tokens on mechanical edits or uploading raw repository archives to third-party tools, `pi-with-chatgpt` introduces a structured **consulting model**:

```text
       ┌─────────────────────────┐
       │         ChatGPT         │  Advisory reasoning only:
       └────────────┬────────────┘  plan / review / audit / challenge
                    │
                    │  GitHub Connector (read-only)
                    ▼
                ┌────────┐  Shared blackboard:
                │ GitHub │  commit / PR / history / tree
                └───▲────┘
                    │
                    │  commit + push (explicit user/worker authority)
       ┌────────────┴────────────┐
       │           Pi            │  Execution authority:
       └─────────────────────────┘  edits / tests / git / final decisions
```

---

## Key Architectural Guarantees

1. **GitHub-Only Context in V1 (INV-02)**:
   Source code reaches ChatGPT exclusively through the GitHub repository you authorize. No local archives, zip files, tunnels, workspace bridges, or file uploads exist.
2. **Immutable Full SHA Checkpoints (INV-03, INV-04)**:
   Every consultation is anchored to an exact 40-character commit SHA verified reachable on the selected GitHub remote before dispatch.
3. **Zero Git Write Authority (INV-06)**:
   The extension never runs `git add -A`, auto-commits, or auto-pushes. Pushing to a remote named `origin` is never assumed to be authorized.
4. **Isolated Browser Profile (INV-11)**:
   ChatGPT operates in an extension-owned, isolated Playwright profile (`~/.pi/agent/pi-with-chatgpt/browser`) locked to `0700` owner-only permissions. Your personal browser session is never automated or hijacked.
5. **Non-Blocking Advisory Failure (INV-07)**:
   By default (`dependency: "advisory"`), provider rate limits, network timeouts, or browser restarts degrade gracefully to local Pi execution without blocking development.
6. **Durable Local Ledger (INV-15)**:
   Consultation requests, markdown advice, and action items (`A1`, `A2`, …) persist in an append-only JSONL ledger in your local agent state directory. Nothing is published to GitHub comments or issues without your explicit action.

---

## 30-Second Quickstart

### 1. Install
Install directly into Pi with one command:
```bash
pi install git:github.com/SaehwanPark/pi-with-chatgpt
```

### 2. Verify Authentication
Run in any Pi session:
```text
/advisor-auth
```
If your OpenAI identity is already stored in Pi, the extension reuses it automatically. If interactive login is required, a dedicated browser window opens for a one-time sign-in.

### 3. Consult Your Senior Adviser
Push your current commit to GitHub, then run:
```text
/advisor-review
```
Pi dispatches the consultation to ChatGPT anchored to your remote commit SHA. You can continue working while the adviser reviews your changes in the background!

---

*Continue to [**Getting Started**](./getting-started) to set up your environment.*
