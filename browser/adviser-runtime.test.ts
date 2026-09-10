/**
 * Login-port mapping tests. The launcher itself is not exercised (it would open Chrome); what matters is
 * that a surface observation maps onto the login flow's terminal set without ever implying that a login
 * could be completed programmatically.
 */
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { AdviserBrowserRuntime, SurfaceObservation } from "./runtime-types.js";
import { loginPortFor, toSessionObservation } from "./adviser-runtime.js";

describe("toSessionObservation", () => {
  it("maps a usable surface to signed-in", () => {
    for (const state of ["conversation-ready", "generating", "response-complete"] as const) {
      expect(toSessionObservation(state)).toEqual({ kind: "signed-in" });
    }
  });

  it("maps a sign-in shell to signed-out", () => {
    expect(toSessionObservation("signed-out")).toEqual({ kind: "signed-out" });
  });

  it("maps a challenge to the right human-verification kind", () => {
    expect(toSessionObservation("human-verification", "Cloudflare challenge")).toEqual({
      kind: "human-verification",
      challenge: "cloudflare",
    });
    expect(toSessionObservation("human-verification", "enter the CAPTCHA")).toEqual({
      kind: "human-verification",
      challenge: "captcha",
    });
    expect(toSessionObservation("human-verification", "confirm it is you")).toEqual({
      kind: "human-verification",
      challenge: "login-checkpoint",
    });
  });

  it("reports unknown and provider errors as unreachable, never as signed-in", () => {
    // Declaring success on an unrecognised page is how a broken surface becomes a false "signed in".
    expect(toSessionObservation("unknown")).toEqual({ kind: "unreachable", reason: "network" });
    expect(toSessionObservation("provider-error")).toEqual({ kind: "unreachable", reason: "network" });
  });
});

describe("Playwright stays a deep import", () => {
  it("keeps playwright-core out of every module but the driver", async () => {
    // Exactly one module may load Playwright: the composition root, and only when a caller actually
    // asks for a browser. `playwright-driver.ts` takes the launcher as a parameter and imports the
    // package structurally, so the lifecycle and DOM logic stay testable with no browser installed.
    // The barrel re-exports neither module, so merely loading the extension pulls in nothing.
    const dir = new URL("./", import.meta.url);
    const files: string[] = await readdir(dir, { recursive: true, encoding: "utf8" });
    const sources = await Promise.all(
      files
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map(async (name) => [name, await readFile(new URL(name, dir), "utf8")] as const),
    );

    const importers = sources
      .filter(([, source]) => /from "playwright-core"/.test(source))
      .map(([name]) => name)
      .sort();
    expect(importers).toEqual(["adviser-runtime.ts"]);
  });
});

describe("login port over the runtime", () => {
  const PROFILE = {
    kind: "extension-owned",
    profileId: "chatgpt-adviser",
    userDataDir: "/state/browser/chatgpt-profile",
    stateRoot: "/state",
  } as const;

  /** A runtime whose surface becomes ready after `signedOutReads`, counting every navigation. */
  function stubRuntime(signedOutReads: number) {
    const observations: SurfaceObservation[] = [];
    let reads = 0;
    const signedOut: SurfaceObservation = { state: "signed-out", explanation: "log in", actionable: false };
    const ready: SurfaceObservation = { state: "conversation-ready", actionable: true };
    // None of these stubs await anything, so they return resolved promises instead of being declared
    // `async`: the runtime only calls them through `await`, and an empty async body trips lint.
    const instance: AdviserBrowserRuntime = {
      status: () =>
        Promise.resolve({
          phase: "ready",
          processAlive: true,
          headed: true,
          profileDir: PROFILE.userDataDir,
          launchCount: 1,
          humanAttentionRequired: false,
        }),
      ensureReady: () => Promise.resolve({ ok: true }),
      probeSurface: () => {
        reads += 1;
        const observation = reads <= signedOutReads ? signedOut : ready;
        observations.push(observation);
        return Promise.resolve(observation);
      },
      discoverModels: () => Promise.resolve({ ok: true, models: [] }),
      consult: () => Promise.resolve({ ok: false, failure: "needs-human" }),
      shutdown: () => Promise.resolve(),
    };
    return { instance, observations };
  }

  it("observes a completed login rather than refusing after the first signed-out read", async () => {
    // The regression this pins: opening the window observes `signed-out`, and if that closed the runtime
    // for later reads, observeSession would never see the login finish and manual login would time out
    // while the user sat signed in at a working window.
    // Reads: 1 = opening the window, 2 = observing while the human is still typing, 3 = after they signed in.
    const { instance, observations } = stubRuntime(2);
    const port = loginPortFor(PROFILE, instance);

    await port.openAdviserWindow(PROFILE);
    expect(await port.observeSession(PROFILE)).toStrictEqual({ kind: "signed-out" });

    // The human signs in at the window, and the next read is allowed to notice.
    expect(await port.observeSession(PROFILE)).toStrictEqual({ kind: "signed-in" });
    expect(observations).toHaveLength(3);
  });

  it("seals only a live browser", async () => {
    const { instance } = stubRuntime(0);
    const port = loginPortFor(PROFILE, instance);
    await expect(port.sealSession(PROFILE)).resolves.toBeUndefined();
  });
});
