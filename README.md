# pi-with-chatgpt

> **ChatGPT advises. Pi decides and executes.**

A [Pi](https://github.com/badlogic/pi-mono) extension that lets an inexpensive or local Pi worker model (such as Qwen 2.5 Coder, Llama 3.3, Claude 3.5 Haiku, or GPT-4o-mini) consult a frontier ChatGPT reasoning model as an external **senior adviser** — for architectural planning, code review, adversarial audits, root-cause debugging, and design challenges.

The division of responsibility is strictly asymmetric:

| Actor | Responsibilities |
| --- | --- |
| **Pi (Worker & User)** | Edits, shell, tests, git, commits, pushes, and the final decision. Sole execution authority. |
| **ChatGPT (Adviser)** | Advisory reasoning only (plan, review, audit, challenge). No execution power, no git write authority. |

📖 **[Read the Full Documentation on GitHub Pages](https://saehwanpark.github.io/pi-with-chatgpt/)**

---

## 30-Second Quickstart

### 1. Install
Install directly into Pi with one command:
```bash
pi install git:github.com/SaehwanPark/pi-with-chatgpt
```

### 2. Verify Authentication
In your Pi interactive session, run:
```text
/advisor-auth
```
Reuses existing OpenAI credentials from Pi or opens a dedicated, isolated browser window (`~/.pi/agent/pi-with-chatgpt/browser`) for a one-time sign-in.

### 3. Consult Your Senior Adviser
Commit and push changes to GitHub, then run:
```text
/advisor-review Focus on error handling in the authentication flow
```
ChatGPT reviews your remote commit SHA while you continue working in Pi!

---

## User Slash Commands

| Command | Purpose |
| --- | --- |
| `/advisor <request>` | General senior advisory on the current checkpoint |
| `/advisor-plan <request>` | Implementation planning and roadmap generation |
| `/advisor-review [request]` | Code review of current commit, branch delta, or PR |
| `/advisor-audit <request>` | Adversarial audit (concurrency, security, recovery) |
| `/advisor-debug <request>` | Root-cause analysis from repository-visible evidence |
| `/advisor-challenge <request>` | Red-team proposed designs and surface trade-offs |
| `/advisor-followup <id> <req>` | Continue prior task conversation with drift awareness |
| `/advisor-status [id]` | Inspect consultation status and dual-cursor drift |
| `/advisor-read [id]` | Expand full advisory response in markdown |
| `/advisor-cancel <id>` | Cancel an in-flight consultation |
| `/advisor-auth` | Inspect credentials and launch browser login |

Pi worker models can also invoke 8 programmatic agent tools (`advisor_preflight`, `advisor_submit`, `advisor_read`, `advisor_status`, `advisor_followup`, `advisor_cancel`, `advisor_auth`, `advisor_disposition`).

---

## Core Architectural Guarantees

1. **GitHub-Only Context (INV-02)**: Source code reaches ChatGPT exclusively through GitHub. No local file uploads, archives, tunnels, or workspace bridges exist.
2. **Immutable Commit Checkpoints (INV-03, INV-04)**: Every consultation anchors to a verified, reachable 40-character commit SHA.
3. **Zero Git Write Authority (INV-06)**: The extension never runs `git add`, `git commit`, or `git push`.
4. **Isolated Browser Profile (INV-11)**: ChatGPT operates in a dedicated Playwright profile locked to `0700` permissions. Your personal browser is never automated.
5. **Non-Blocking Advisory Failure (INV-07)**: Provider outages or rate limits degrade gracefully to local worker execution without freezing Pi.
6. **Durable Local Ledger (INV-15)**: Consultations and action items (`A1`, `A2`, …) persist locally in JSONL. Rejections require a mandatory recorded rationale.

---

## Documentation Links

- [**Getting Started**](https://saehwanpark.github.io/pi-with-chatgpt/getting-started/): Detailed installation and first-time setup walkthrough.
- [**User Guide (Slash Commands)**](https://saehwanpark.github.io/pi-with-chatgpt/user-guide/): Command syntax, parameters, and workflow examples.
- [**Agent Tools Reference**](https://saehwanpark.github.io/pi-with-chatgpt/agent-tools/): Technical schemas for worker model integration.
- [**Configuration Guide**](https://saehwanpark.github.io/pi-with-chatgpt/configuration/): Global and project settings, timeouts, and env vars.
- [**Drift & Disposition Guide**](https://saehwanpark.github.io/pi-with-chatgpt/drift-and-disposition/): Dual cursors, 5 drift tiers, and action-item tracking.
- [**Troubleshooting & FAQs**](https://saehwanpark.github.io/pi-with-chatgpt/troubleshooting/): Authentication, CAPTCHAs, and common resolutions.
- [**Architecture & Safety Invariants**](https://saehwanpark.github.io/pi-with-chatgpt/architecture-and-safety/): Complete review of all 16 safety invariants.

---

## Development & Verification

```bash
npm ci
npm run typecheck    # tsc --noEmit over sources and tests
npm run lint         # type-aware eslint
npm run build        # build to dist/
npm test             # vitest unit & integration test suite
npm run smoke:pi     # end-to-end Pi extension load & install smoke test
npm run verify       # run all verification steps
```

---

## License

[MIT](LICENSE)
