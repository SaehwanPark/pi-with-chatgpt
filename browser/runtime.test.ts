/**
 * M3 lifecycle tests. Everything here runs against a fake driver: the point is to prove the *rules*
 * (lazy start, reuse, crash recovery, bounded retry, serialised turns, terminal human gate), and none of
 * those rules depend on a real browser.
 */
import { describe, expect, it } from "vitest";

import type {
  AdviserPageDriver,
  ConsultationOutcome,
  ConsultationRequest,
  ModelOption,
  RuntimeStartOptions,
  SurfaceObservation,
} from "./runtime-types.js";
import { AdviserRuntime, type RuntimeEvent } from "./runtime.js";

interface DriverScript {
  healthy?: boolean[];
  startResults?: Array<{ ok: boolean; error?: string }>;
  surface?: SurfaceObservation;
  models?: readonly ModelOption[];
  selectOk?: boolean;
  turn?: ConsultationOutcome | (() => Promise<ConsultationOutcome>);
}

function fakeDriver(script: DriverScript = {}) {
  const calls: string[] = [];
  const healthAnswers = [...(script.healthy ?? [true])];
  const startResults = [...(script.startResults ?? [{ ok: true as const }])];
  const surface: SurfaceObservation = script.surface ?? { state: "conversation-ready", actionable: true };

  // None of these fakes await anything, so they return resolved promises rather than being declared
  // `async`: the runtime only ever calls them through `await`, and an empty async body trips lint.
  const driver: AdviserPageDriver = {
    start: (options: RuntimeStartOptions) => {
      calls.push(`start:${options.purpose}`);
      // When the script runs out, starts succeed: only scripted failures should stop the runtime.
      const next = startResults.shift();
      if (next && !next.ok) return Promise.reject(new Error(next.error ?? "launch failed"));
      return Promise.resolve({ chromeVersion: "152.0.0.0" });
    },
    isHealthy: () => {
      calls.push("isHealthy");
      return Promise.resolve(healthAnswers.length > 0 ? healthAnswers.shift()! : true);
    },
    resetTab: () => {
      calls.push("resetTab");
      return Promise.resolve();
    },
    observeSurface: () => {
      calls.push("observeSurface");
      return Promise.resolve(surface);
    },
    openChatGPT: () => Promise.resolve(surface),
    listModels: () => {
      calls.push("listModels");
      return Promise.resolve(script.models ?? [{ modelId: "gpt-5.5", displayName: "GPT-5.5", available: true }]);
    },
    selectModel: (modelId: string) => {
      calls.push(`selectModel:${modelId}`);
      return Promise.resolve(script.selectOk ?? true);
    },
    askAndAwaitTurn: (request: ConsultationRequest) => {
      calls.push(`ask:${request.consultationId}`);
      if (typeof script.turn === "function") return script.turn();
      return Promise.resolve(script.turn ?? { ok: true as const, text: "advice", elapsedMs: 10 });
    },
    shutdown: () => {
      calls.push("shutdown");
      return Promise.resolve();
    },
  };
  return { driver, calls };
}

type RuntimeOverrides = Omit<ConstructorParameters<typeof AdviserRuntime>[0], "driver" | "profileDir">;
function runtime(script: DriverScript = {}, overrides: RuntimeOverrides = {}) {
  const { driver, calls } = fakeDriver(script);
  const events: RuntimeEvent[] = [];
  const instance = new AdviserRuntime({
    driver,
    profileDir: "/state/browser/chatgpt-profile",
    launchBackoffMs: 0,
    ...overrides,
  });
  instance.subscribe((event) => events.push(event));
  return { instance, calls, events };
}

const REQUEST: ConsultationRequest = {
  consultationId: "c-1",
  prompt: "Review this checkpoint.",
  modelId: "gpt-5.5",
};

describe("AdviserRuntime startup", () => {
  it("does not launch until something needs the browser", async () => {
    const { instance, calls } = runtime();
    const status = await instance.status();
    expect(status.phase).toBe("stopped");
    expect(status.processAlive).toBe(false);
    expect(calls).toStrictEqual([]);
  });

  it("launches once and reuses the browser across consultations", async () => {
    const { instance, calls } = runtime();
    await instance.consult(REQUEST);
    await instance.consult({ ...REQUEST, consultationId: "c-2" });
    expect(calls.filter((call) => call.startsWith("start:"))).toStrictEqual(["start:consultation"]);
    expect((await instance.status()).launchCount).toBe(1);
  });

  it("launches only once for concurrent callers sharing one profile", async () => {
    // Two consultations racing on a cold runtime used to produce two Chrome processes against one
    // user-data-dir; the loser dies with a profile-lock error that reads like a Chrome bug.
    const { instance, calls } = runtime();
    await Promise.all([
      instance.consult({ ...REQUEST, consultationId: "a" }),
      instance.consult({ ...REQUEST, consultationId: "b" }),
      instance.ensureReady(),
    ]);
    expect(calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
  });

  it("reports a missing Chrome as chrome-not-found rather than a generic launch failure", async () => {
    const { instance } = runtime({
      startResults: [
        { ok: false, error: "Chromium distribution 'chrome' is not found at /opt/chrome" },
        { ok: false, error: "Chromium distribution 'chrome' is not found at /opt/chrome" },
      ],
    });
    const first = await instance.ensureReady();
    expect(first).toStrictEqual({ ok: false, rejection: "chrome-not-found" });
    // One retry is allowed; the second consecutive failure is the point where retrying stops helping.
    expect(await instance.ensureReady()).toStrictEqual({ ok: false, rejection: "chrome-not-found" });
    expect((await instance.status()).phase).toBe("failed");
  });

  it("retries a transient launch failure once, then succeeds", async () => {
    const { instance, events } = runtime({
      startResults: [{ ok: false, error: "chrome died during startup" }],
    });
    await expect(instance.ensureReady()).resolves.toStrictEqual({ ok: false, rejection: "launch-failed" });
    await expect(instance.ensureReady()).resolves.toEqual({ ok: true });
    expect(events.filter((event) => event.type === "launch-failed")).toHaveLength(1);
  });

  it("gives up after the configured attempts instead of retrying forever", async () => {
    const { instance, calls } = runtime({
      startResults: [
        { ok: false, error: "boom" },
        { ok: false, error: "boom" },
        { ok: false, error: "boom" },
      ],
    });
    await instance.ensureReady();
    await instance.ensureReady();
    await instance.ensureReady();
    // Two attempts are made in total; the third call short-circuits without touching the driver.
    expect(calls.filter((call) => call.startsWith("start:"))).toHaveLength(2);
  });
});

describe("AdviserRuntime health", () => {
  it("relaunches when a supposedly ready browser is no longer healthy", async () => {
    const { instance, calls } = runtime({ healthy: [false, true, true, true] });
    await instance.ensureReady();
    await instance.ensureReady();
    expect(calls.filter((call) => call.startsWith("start:")).length).toBe(2);
    expect((await instance.status()).launchCount).toBe(2);
  });

  it("treats a health check that throws as unhealthy rather than propagating", async () => {
    const { driver } = fakeDriver();
    driver.isHealthy = () => Promise.reject(new Error("pipe closed"));
    const instance = new AdviserRuntime({ driver, profileDir: "/state/browser/chatgpt-profile" });
    await instance.ensureReady();
    expect((await instance.status()).processAlive).toBe(false);
  });
});

describe("AdviserRuntime turns", () => {
  it("refuses to ask a question the page cannot receive", async () => {
    const { instance, calls } = runtime({ surface: { state: "signed-out", actionable: false } });
    const outcome = await instance.consult(REQUEST);
    expect(outcome).toStrictEqual({ ok: false, failure: "needs-human" });
    expect(calls).not.toContainEqual(expect.stringContaining("ask:"));
  });

  it("reports model-unavailable instead of asking a different model", async () => {
    // Silent downgrade is the failure users cannot see: they get weaker advice and no signal.
    const { instance, calls } = runtime({ selectOk: false });
    const outcome = await instance.consult(REQUEST);
    expect(outcome).toStrictEqual({ ok: false, failure: "model-unavailable" });
    expect(calls.some((call) => call.startsWith("ask:"))).toBe(false);
  });

  it("marks the browser degraded when the driver dies mid-turn, and recovers on the next call", async () => {
    let first = true;
    const { instance, calls } = runtime({
      turn: () => {
        if (first) {
          first = false;
          return Promise.reject(new Error("page crashed"));
        }
        return Promise.resolve({ ok: true as const, text: "advice", elapsedMs: 5 });
      },
    });
    await expect(instance.consult(REQUEST)).resolves.toStrictEqual({ ok: false, failure: "browser-lost" });
    expect((await instance.status()).phase).toBe("degraded");
    await expect(instance.consult({ ...REQUEST, consultationId: "c-2" })).resolves.toMatchObject({ ok: true });
    expect(calls.filter((call) => call.startsWith("start:")).length).toBe(2);
  });

  it("passes the bounded turn timeout to the driver", async () => {
    let seen: number | undefined;
    const { driver } = fakeDriver();
    driver.askAndAwaitTurn = (request) => {
      seen = request.timeoutMs;
      return Promise.resolve({ ok: true, text: "x", elapsedMs: 1 });
    };
    const instance = new AdviserRuntime({ driver, profileDir: "/p", defaultTurnTimeoutMs: 1234 });
    await instance.consult(REQUEST);
    expect(seen).toBe(1234);
  });

  it("keeps the turn queue usable after a failed turn", async () => {
    let attempts = 0;
    const { instance } = runtime({
      turn: () => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? ({ ok: false, failure: "generation-timeout" } as const)
            : ({ ok: true, text: "late advice", elapsedMs: 2 } as const),
        );
      },
    });
    await expect(instance.consult(REQUEST)).resolves.toMatchObject({ ok: false });
    await expect(instance.consult({ ...REQUEST, consultationId: "c-2" })).resolves.toMatchObject({
      ok: true,
      text: "late advice",
    });
  });
});

describe("AdviserRuntime human gate", () => {
  it("stops trying once a challenge is observed", async () => {
    // Polling through a CAPTCHA is automating the CAPTCHA by omission, so the gate must be terminal.
    const { instance, calls } = runtime({
      surface: { state: "human-verification", explanation: "challenge page", actionable: false },
    });
    await instance.consult(REQUEST);
    const before = calls.length;
    await instance.ensureReady();
    await instance.probeSurface();
    expect(calls.slice(before).filter((call) => call.startsWith("start:"))).toStrictEqual([]);
    expect((await instance.status()).humanAttentionRequired).toBe(true);
  });

  it("reports needs-human from the gate rather than relaunching", async () => {
    const { instance } = runtime({
      surface: { state: "human-verification", explanation: "challenge", actionable: false },
    });
    await instance.probeSurface();
    expect(await instance.ensureReady()).toStrictEqual({ ok: false, rejection: "needs-human" });
  });
});

describe("AdviserRuntime status and shutdown", () => {
  it("closes the driver once and stays closed", async () => {
    const { instance, calls } = runtime();
    await instance.ensureReady();
    await instance.shutdown();
    await instance.shutdown();
    expect(calls.filter((call) => call === "shutdown")).toHaveLength(1);
    expect((await instance.status()).phase).toBe("stopped");
  });

  it("exposes no accessor that could address the page", () => {
    // The worker-facing surface must not be able to reach a driver, a page, or a selector.
    const { instance } = runtime();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(instance))).toStrictEqual(
      expect.arrayContaining(["status", "ensureReady", "probeSurface", "discoverModels", "consult", "shutdown"]),
    );
    for (const forbidden of ["driver", "page", "context", "browser", "evaluate", "click", "navigate"]) {
      expect((instance as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it("survives a listener that throws", async () => {
    const { driver } = fakeDriver();
    const instance = new AdviserRuntime({ driver, profileDir: "/p" });
    instance.subscribe(() => {
      throw new Error("bad listener");
    });
    await expect(instance.ensureReady()).resolves.toEqual({ ok: true });
  });

  it("does not list models through a signed-out surface", async () => {
    const { instance, calls } = runtime({ surface: { state: "signed-out", actionable: false } });
    expect(await instance.discoverModels()).toStrictEqual({ ok: false, rejection: "needs-human" });
    expect(calls).not.toContain("listModels");
  });
});
