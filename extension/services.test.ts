import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.js";
import { adviserStateLayout } from "../config/state-layout.js";
import type { AdviserBrowserBundle } from "../browser/adviser-runtime.js";
import { createProductionServiceFactory } from "./services.js";

function emptyBrowserBundle(): AdviserBrowserBundle {
  return {
    runtime: {} as AdviserBrowserBundle["runtime"],
    loginPort: {} as AdviserBrowserBundle["loginPort"],
    projectSurface: {} as AdviserBrowserBundle["projectSurface"],
    profile: {} as AdviserBrowserBundle["profile"],
  };
}

describe("production adviser composition", () => {
  it("creates the browser-backed service graph lazily and only once per activation", async () => {
    let browserFactoryCalls = 0;
    const factory = createProductionServiceFactory({
      config: DEFAULT_CONFIG,
      statePaths: {
        stateRoot: "/tmp/pwc-state",
        browserRoot: "/tmp/pwc-state/pi-with-chatgpt/browser",
        profileDir: "/tmp/pwc-state/pi-with-chatgpt/browser/chatgpt-profile",
        chromeImportDir: "/tmp/pwc-state/pi-with-chatgpt/browser/chrome-imports",
        capabilityStateFile: "/tmp/pwc-state/pi-with-chatgpt/browser/capability.json",
        diagnosticsDir: "/tmp/pwc-state/pi-with-chatgpt/browser/diagnostics",
      },
      browserFactory: () => {
        browserFactoryCalls += 1;
        return Promise.resolve(emptyBrowserBundle());
      },
    });

    expect(browserFactoryCalls).toBe(0);
    const first = await factory("/repo");
    expect(browserFactoryCalls).toBe(1);

    const second = await factory("/repo");
    expect(browserFactoryCalls).toBe(1);
    expect(second.engine).toBe(first.engine);
    expect(second.loginPort).toBe(first.loginPort);

    const otherWorkspace = await factory("/another-repo");
    expect(browserFactoryCalls).toBe(1);
    expect(otherWorkspace.engine).not.toBe(first.engine);
    expect(otherWorkspace.loginPort).toBe(first.loginPort);
  });

  it("keeps the production layout rooted at the configured state directory", async () => {
    let observedLayout: string | undefined;
    const factory = createProductionServiceFactory({
      config: DEFAULT_CONFIG,
      statePaths: {
        stateRoot: "/tmp/pwc-other-agent",
        browserRoot: "/tmp/pwc-other-agent/pi-with-chatgpt/browser",
        profileDir: "/tmp/pwc-other-agent/pi-with-chatgpt/browser/chatgpt-profile",
        chromeImportDir: "/tmp/pwc-other-agent/pi-with-chatgpt/browser/chrome-imports",
        capabilityStateFile: "/tmp/pwc-other-agent/pi-with-chatgpt/browser/capability.json",
        diagnosticsDir: "/tmp/pwc-other-agent/pi-with-chatgpt/browser/diagnostics",
      },
      browserFactory: () => {
        observedLayout = adviserStateLayout("/tmp/pwc-other-agent").stateRoot;
        return Promise.resolve(emptyBrowserBundle());
      },
    });

    await factory("/repo");
    expect(observedLayout).toBe("/tmp/pwc-other-agent/pi-with-chatgpt");
  });
});
