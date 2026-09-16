# Browser Identity Resolution and Connector Capability Fix

**Date:** 2026-09-16  
**Status:** In Progress  
**Scope:** Resolution of isolated ChatGPT browser account identification failure and GitHub connector capability preflight blockage in `pi-with-chatgpt`.

---

## 1. Incident Summary

When running Pi with `pi-with-chatgpt` on a real-world repository with an active Pi session:
1. The user opened the isolated browser via the extension, logged in to ChatGPT (`chatgpt.com`), and verified full authentication as `Saehwan Park` (`Plus`), with the prompt composer ready.
2. When the user prompted Pi to check authentication, Pi executed `advisor_auth` and `advisor_preflight`.
3. `advisor_auth` returned `authenticated=false`.
4. `advisor_preflight` returned:
   ```text
   Preflight refused: The isolated ChatGPT browser account could not be identified; consultation is refused until it is verified.
   ```
5. Subsequent `advisor_submit` attempts failed with the same refusal message.
6. The assistant reported that authentication remained incomplete and paused the goal.

---

## 2. Root Cause Analysis

### Root Cause A: `browserSession.identity` Never Extracted by Playwright Driver
In [`browser/playwright-driver.ts`](../../browser/playwright-driver.ts), `openChatGPT()` calls `this.#snapshot()` and maps it with `toObservation(snapshot)`.
`toObservation()` only populates:
```typescript
function toObservation(snapshot: SurfaceSnapshot): SurfaceObservation {
  const classified = classifySurface(snapshot);
  return {
    state: classified.state,
    explanation: classified.explanation,
    actionable: classified.actionable,
  };
}
```
`identity` is never populated on `SurfaceObservation`.
In [`browser/adviser-runtime.ts`](../../browser/adviser-runtime.ts), `toSessionObservation()` receives an undefined `identity`, returning:
```typescript
{ kind: "signed-in", identity: undefined }
```
As a result, `browserSession.identity` is always `undefined` in production.

### Root Cause B: Fail-Closed Identity Gate in `auth/readiness.ts`
Commit `aa2a46e1` introduced [`auth/readiness.ts`](../../auth/readiness.ts) with the following logic:
```typescript
if (
  (input.requireBrowserIdentity ?? true) &&
  input.browserSession?.kind === "signed-in" &&
  input.browserSession.identity === undefined &&
  decision.action === "consult"
) {
  return {
    ...decision,
    state: "browser-identity-unverified",
    action: "review-account-mismatch",
    explanation: "The isolated ChatGPT browser account could not be identified; consultation is refused until it is verified.",
    requiresManualIntervention: true,
    identityComparison: "unknown",
    warnings: [...decision.warnings, "Browser account identity is unavailable; no account switch is permitted."],
  };
}
```
Because `browserSession.identity` was never populated, this check triggered on every signed-in browser session.

### Root Cause C: `advisor_auth` Maps `review-account-mismatch` to `authenticated: false`
In [`extension/tools.ts`](../../extension/tools.ts), `advisor_auth` evaluated:
```typescript
const authenticated: boolean | "unknown" =
  authDecision.action === "review-account-mismatch"
    ? false
    : status.browserSession.state === "signed-in"
    ? true
    : ...
```
Because `authDecision.action` was `"review-account-mismatch"`, `authenticated` was forced to `false`.

### Root Cause D: Preflight and Submit Refusal
In [`extension/tools.ts`](../../extension/tools.ts) (`advisor_preflight` and `advisor_submit`), `requireLiveAuth` checks `authDecisionAllowsConsultation(decision)`, which requires `action === "consult"`. With `action === "review-account-mismatch"`, both tools immediately refuse execution.

### Root Cause E: Hardcoded `unverifiedGitHubConnectorProbe`
Immediately behind the auth check, [`advisor_preflight`](../../extension/tools.ts) and [`advisor_submit`](../../extension/tools.ts) call `requireCapability()`.
In [`browser/adviser-runtime.ts`](../../browser/adviser-runtime.ts):
```typescript
const unverifiedGitHubConnectorProbe: GitHubConnectorProbe = () => Promise.resolve("unverified");
```
And in [`extension/index.ts`](../../extension/index.ts), no probe is supplied during default activation.
Because `github-connector` is in `REQUIRED_BEFORE_FIRST_CONSULTATION`, any consultation would subsequently fail with:
```text
Consultation capability check failed (github-connector:unverified).
```

---

## 3. Remediation Plan

1. **Browser Identity Extraction**:
   - In [`browser/playwright-driver.ts`](../../browser/playwright-driver.ts), add account identity discovery by checking `/api/auth/session` on `chatgpt.com` or reading account profile metadata.
   - Support reading profile identity hints from the Chromium `Preferences` / `Local State` in [`browser/chrome-state.ts`](../../browser/chrome-state.ts) / [`browser/adviser-runtime.ts`](../../browser/adviser-runtime.ts).
   - Ensure `SurfaceObservation.identity` is correctly passed to `toSessionObservation()`.

2. **Readiness Gate Alignment**:
   - In [`auth/readiness.ts`](../../auth/readiness.ts), ensure that if browser identity matches Pi identity (e.g. matching account ID or matching masked email), it produces `confirmed` / `ready` and allows consultation.
   - If identity cannot be extracted from the DOM but the session is proven signed-in without a demonstrated mismatch, align with [`auth/adviser-auth.ts`](../../auth/adviser-auth.ts) to permit advisory consultation (`ready-unverified-identity` with appropriate warning) rather than deadlocking the user.

3. **Functional Connector Verification**:
   - Provide a functional GitHub connector probe in [`browser/adviser-runtime.ts`](../../browser/adviser-runtime.ts) and [`browser/consultation-capability.ts`](../../browser/consultation-capability.ts). When the user is logged into ChatGPT and the target repository is verified on GitHub, probe or treat connector availability as verified when active.

4. **Testing and Release**:
   - Run typecheck, linting, and full test suite.
   - Bump version to 1.0.6, update changelog, merge to `main`, and create release.
