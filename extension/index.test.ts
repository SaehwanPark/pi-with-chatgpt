import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import activateExtension, { activate, MIN_PI_VERSION } from "./index.js";
import { DEFAULT_CONFIG } from "../config/schema.js";
import type { AdviserExtensionApi } from "./pi-api.js";

const moduleDir = fileURLToPath(new URL("./", import.meta.url));

interface MockPi extends AdviserExtensionApi {
  readonly registerCalls: string[];
  readonly eventCalls: string[];
}

function mockPi(): MockPi {
  const registerCalls: string[] = [];
  const eventCalls: string[] = [];
  return {
    registerCalls,
    eventCalls,
    registerCommand(name: string): void {
      registerCalls.push(name);
    },
    on(event: string): void {
      eventCalls.push(event);
    },
  };
}

describe("extension activation (M0 exit criterion)", () => {
  it("activates without registering anything", () => {
    const pi = mockPi();
    const activation = activateExtension(pi);
    expect(activation.config).toEqual(DEFAULT_CONFIG);
    expect(activation.registeredCommands).toEqual([]);
    expect(pi.registerCalls).toEqual([]);
    expect(pi.eventCalls).toEqual([]);
  });

  it("accepts an injected configuration without validating the environment", () => {
    const activation = activate(mockPi(), { ...DEFAULT_CONFIG, defaultMode: "async" });
    expect(activation.config.defaultMode).toBe("async");
  });

  it("registers nothing when a caller passes an API it should not use", () => {
    // A guard against future "convenient" activation-time side effects: the mock records everything.
    const spy = vi.fn();
    const pi: AdviserExtensionApi = { registerCommand: spy, on: spy };
    activate(pi);
    expect(spy).not.toHaveBeenCalled();
  });

  it("declares the Pi version floor it is tested against", () => {
    expect(MIN_PI_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("performs no I/O at module load or activation time", () => {
    // Activation must never touch the filesystem, launch a browser, or run git: a broken adviser
    // setup may not degrade an ordinary Pi session.
    const forbiddenImport = /from "(node:fs|node:child_process|node:net|node:http|node:https|playwright[^"]*)"/u;
    const offenders = readdirSync(moduleDir)
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      .filter((entry) => forbiddenImport.test(readFileSync(join(moduleDir, entry), "utf8")));
    expect(offenders).toEqual([]);
  });
});
