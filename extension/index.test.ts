import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import activateExtension, { activate, MIN_PI_VERSION, registerSessionLifecycle } from "./index.js";
import { DEFAULT_CONFIG } from "../config/schema.js";
import { getPiSessionId, type AdviserExtensionApi, type AdviserExtensionContext, type AdviserToolDefinition } from "./pi-api.js";
import type { ConsultationEngine, WakeUpNotification } from "../jobs/engine.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import type { ConsultationId } from "../protocol/checkpoint.js";

const moduleDir = fileURLToPath(new URL("./", import.meta.url));

interface MockPi extends AdviserExtensionApi {
  readonly registerCalls: string[];
  readonly registerToolCalls: string[];
  readonly eventCalls: string[];
  readonly eventHandlers: Map<string, (payload: unknown, ctx: AdviserExtensionContext) => void | Promise<void>>;
}

function mockPi(): MockPi {
  const registerCalls: string[] = [];
  const registerToolCalls: string[] = [];
  const eventCalls: string[] = [];
  const eventHandlers = new Map<string, (payload: unknown, ctx: AdviserExtensionContext) => void | Promise<void>>();
  return {
    registerCalls,
    registerToolCalls,
    eventCalls,
    eventHandlers,
    registerCommand(name: string): void {
      registerCalls.push(name);
    },
    registerTool(tool: AdviserToolDefinition<unknown, unknown>): void {
      registerToolCalls.push(tool.name);
    },
    on(event: string, handler: (payload: unknown, ctx: AdviserExtensionContext) => void | Promise<void>): void {
      eventCalls.push(event);
      eventHandlers.set(event, handler);
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

  it("binds async wake-ups to the real Pi session lifecycle", async () => {
    const unsubscribe = vi.fn();
    let listener: ((notification: WakeUpNotification) => void) | undefined;
    const registerWakeUpListener = vi.fn((_sessionId: string, callback: (notification: WakeUpNotification) => void) => {
      listener = callback;
      return unsubscribe;
    });
    const engine = { registerWakeUpListener } as unknown as ConsultationEngine;
    const pi = mockPi();
    activate(pi, { engine });

    const notifications: string[] = [];
    const ctx = {
      cwd: "/repo",
      sessionManager: { getSessionId: () => "pi-session-real" },
      ui: { notify: (message: string) => notifications.push(message) },
      isProjectTrusted: () => true,
    };
    await pi.eventHandlers.get("session_start")?.({}, ctx);

    expect(registerWakeUpListener).toHaveBeenCalledWith("pi-session-real", expect.any(Function));
    listener?.({
      address: {
        repository: canonicalRepositoryKey("acme", "repo"),
        taskId: "pi-session-real",
        consultationId: "adv-async1234" as ConsultationId,
        deliveryKey: "0".repeat(64),
      },
      state: "failed",
    });
    expect(notifications[0]).toContain("adv-async1234 failed");

    await pi.eventHandlers.get("session_shutdown")?.({}, ctx);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not initialize adviser services for an untrusted project", async () => {
    const pi = mockPi();
    const resolveEngine = vi.fn(() => Promise.resolve({
      registerWakeUpListener: vi.fn(),
    } as unknown as ConsultationEngine));
    registerSessionLifecycle(pi, resolveEngine);

    const notifications: string[] = [];
    const ctx = {
      cwd: "/untrusted",
      sessionManager: { getSessionId: () => "pi-session-untrusted" },
      isProjectTrusted: () => false,
      ui: { notify: (message: string) => notifications.push(message) },
    };
    await pi.eventHandlers.get("session_start")?.({}, ctx);

    expect(resolveEngine).not.toHaveBeenCalled();
    expect(notifications[0]).toContain("does not trust this project");
  });

  it("refuses an empty Pi session identity instead of sharing a default session", () => {
    expect(() => getPiSessionId({ sessionManager: { getSessionId: () => "  " } })).toThrow(
      "Pi session manager returned an empty session ID",
    );
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
