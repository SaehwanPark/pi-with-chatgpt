/**
 * Login-port mapping tests. The launcher itself is not exercised (it would open Chrome); what matters is
 * that a surface observation maps onto the login flow's terminal set without ever implying that a login
 * could be completed programmatically.
 */
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { toSessionObservation } from "./adviser-runtime.js";

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
