import { describe, expect, it } from "vitest";

import type { AdviserProfile } from "../browser/profile.js";
import { runManualLogin, sessionMarkerPath, shouldOfferInteractiveLogin, type AdviserLoginPort, type SessionObservation } from "./login-flow.js";

const PROFILE = {
  kind: "extension-owned",
  profileId: "chatgpt-adviser",
  userDataDir: "/home/ada/.pi/agent/pi-with-chatgpt/browser/chatgpt-profile",
  stateRoot: "/home/ada/.pi/agent",
} as const satisfies AdviserProfile;

const IDENTITY = { source: "chatgpt-browser", accountIdHint: "acct-1" } as const;

/** Scripted port: each call to observeSession returns the next scripted observation. */
function fakePort(script: readonly SessionObservation[], options: { readonly openFails?: boolean } = {}) {
  const calls: { opened: number; sealed: number; observed: number } = { opened: 0, sealed: 0, observed: 0 };
  const port: AdviserLoginPort = {
    openAdviserWindow: () => {
      calls.opened += 1;
      return options.openFails === true ? Promise.reject(new Error("no display")) : Promise.resolve();
    },
    observeSession: () => {
      const observation = script[Math.min(calls.observed, script.length - 1)] ?? { kind: "signed-out" };
      calls.observed += 1;
      return Promise.resolve(observation);
    },
    sealSession: () => {
      calls.sealed += 1;
      return Promise.resolve();
    },
  };
  return { port, calls };
}

/** A clock that advances only when the flow sleeps, so no test waits in real time. */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

function run(script: readonly SessionObservation[], options: Parameters<typeof runManualLogin>[2] = {}, portOptions = {}) {
  const { port, calls } = fakePort(script, portOptions);
  const markers: string[] = [];
  const clock = fakeClock();
  return {
    calls,
    markers,
    result: runManualLogin(PROFILE, port, {
      timeoutMs: 10_000,
      pollIntervalMs: 1_000,
      ...clock,
      writeMarker: (path) => {
        markers.push(path);
        return Promise.resolve();
      },
      ...options,
    }),
  };
}

describe("runManualLogin", () => {
  it("opens the window and succeeds once the human has signed in", async () => {
    const { result, calls, markers } = run([{ kind: "signed-out" }, { kind: "signed-in", identity: IDENTITY }]);
    const outcome = await result;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.identity?.accountIdHint).toBe("acct-1");
    expect(outcome.attempts).toBe(2);
    expect(calls.opened).toBe(1);
    expect(calls.sealed).toBe(1);
    expect(markers).toEqual([sessionMarkerPath(PROFILE)]);
  });

  it("seals the profile before reporting success", async () => {
    // An unsealed profile comes back logged out on next launch, which is the bug being prevented.
    const order: string[] = [];
    const port: AdviserLoginPort = {
      openAdviserWindow: () => Promise.resolve(),
      observeSession: () => Promise.resolve({ kind: "signed-in" }),
      sealSession: () => {
        order.push("seal");
        return Promise.resolve();
      },
    };
    const outcome = await runManualLogin(PROFILE, port, {
      now: () => 0,
      sleep: () => Promise.resolve(),
      writeMarker: () => {
        order.push("marker");
        return Promise.resolve();
      },
    });
    expect(outcome.ok).toBe(true);
    expect(order).toEqual(["seal", "marker"]);
  });

  it("stops at a human challenge instead of waiting it out", async () => {
    const { result, calls } = run([{ kind: "human-verification", challenge: "captcha" }]);
    const outcome = await result;
    expect(!outcome.ok && outcome.failure).toBe("human-verification");
    if (outcome.ok) return;
    // Waiting longer cannot help, so the caller must ask the human rather than poll.
    expect(outcome.retryMayHelp).toBe(false);
    expect(calls.observed).toBe(1);
  });

  it("gives up at the deadline rather than looping forever", async () => {
    const { result } = run([{ kind: "signed-out" }]);
    const outcome = await result;
    expect(!outcome.ok && outcome.failure).toBe("timed-out");
    if (outcome.ok) return;
    // 10s budget at 1s polls: it polled, then stopped.
    expect(outcome.attempts).toBe(11);
    expect(outcome.retryMayHelp).toBe(true);
  });

  it("reports an unreachable network without claiming the credentials were wrong", async () => {
    const { result } = run([{ kind: "unreachable", reason: "network" }]);
    const outcome = await result;
    expect(!outcome.ok && outcome.failure).toBe("unreachable");
    if (outcome.ok) return;
    expect(outcome.detail).toMatch(/network/u);
    expect(outcome.retryMayHelp).toBe(true);
  });

  it("does not call a locked profile a login failure", async () => {
    const { result } = run([{ kind: "unreachable", reason: "profile-locked" }]);
    const outcome = await result;
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.retryMayHelp).toBe(false);
  });

  it("reports a window that never opened without observing anything", async () => {
    const { result, calls } = run([{ kind: "signed-in" }], {}, { openFails: true });
    const outcome = await result;
    expect(!outcome.ok && outcome.failure).toBe("window-failed");
    expect(calls.observed).toBe(0);
  });

  it("still reports success when the marker cannot be written", async () => {
    // The marker improves messaging only; a signed-in profile must not be called a failure.
    const { port } = fakePort([{ kind: "signed-in" }]);
    const outcome = await runManualLogin(PROFILE, port, {
      now: () => 0,
      sleep: () => Promise.resolve(),
      writeMarker: () => Promise.reject(new Error("read-only filesystem")),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.markerWritten).toBe(false);
  });
});

describe("shouldOfferInteractiveLogin", () => {
  it("offers login for a fresh or expired profile", () => {
    expect(shouldOfferInteractiveLogin({ everSignedInHere: false, sessionObserved: false, humanVerificationPending: false })).toBe(true);
    expect(shouldOfferInteractiveLogin({ everSignedInHere: true, sessionObserved: false, humanVerificationPending: false })).toBe(true);
  });

  it("does not nag once a session exists", () => {
    expect(shouldOfferInteractiveLogin({ everSignedInHere: true, sessionObserved: true, humanVerificationPending: false })).toBe(false);
  });

  it("does not open a second window over a pending challenge", () => {
    expect(shouldOfferInteractiveLogin({ everSignedInHere: true, sessionObserved: false, humanVerificationPending: true })).toBe(false);
  });
});

describe("session marker", () => {
  it("lives inside the extension-owned profile, never the repository", () => {
    expect(sessionMarkerPath(PROFILE)).toBe(`${PROFILE.userDataDir}/SESSION-ESTABLISHED`);
  });
});
