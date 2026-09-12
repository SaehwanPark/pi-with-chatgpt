import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import activateExtension, { activate, MIN_PI_VERSION } from "./index.js";
import { DEFAULT_CONFIG } from "../config/schema.js";
import type { AdviserExtensionApi, AdviserToolDefinition } from "./pi-api.js";

const moduleDir = fileURLToPath(new URL("./", import.meta.url));

interface MockPi extends AdviserExtensionApi {
  readonly registerCalls: string[];
  readonly registerToolCalls: string[];
  readonly eventCalls: string[];
}

function mockPi(): MockPi {
  const registerCalls: string[] = [];
  const registerToolCalls: string[] = [];
  const eventCalls: string[] = [];
  return {
    registerCalls,
    registerToolCalls,
    eventCalls,
    registerCommand(name: string): void {
      registerCalls.push(name);
    },
    registerTool(tool: AdviserToolDefinition<unknown, unknown>): void {
      registerToolCalls.push(tool.name);
    },
    on(event: string): void {
      eventCalls.push(event);
    },
  };
}

describe("extension activation (M8)", () => {
  it("activates and registers all 11 slash commands and 8 agent tools", () => {
    const pi = mockPi();
    const activation = activateExtension(pi);
    expect(activation.config).toEqual(DEFAULT_CONFIG);
    expect(activation.registeredCommands.length).toBe(11);
    expect(activation.registeredTools.length).toBe(8);
    expect(pi.registerCalls.length).toBe(11);
    expect(pi.registerToolCalls.length).toBe(8);
  });

  it("accepts an injected configuration without validating the environment", () => {
    const activation = activate(mockPi(), { ...DEFAULT_CONFIG, defaultMode: "async" });
    expect(activation.config.defaultMode).toBe("async");
    expect(activation.registeredCommands.length).toBe(11);
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
