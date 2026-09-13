import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../config/schema.js";
import { adviserStateLayout } from "../config/state-layout.js";
import type { AdviserBrowserBundle } from "../browser/adviser-runtime.js";
import type { AdviserBrowserRuntime, ConsultationOutcome, ConsultationRequest, ModelOption, RuntimeStatus, SurfaceObservation } from "../browser/runtime-types.js";
import { createBrowserTransactionScheduler } from "../browser/transaction.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import { fakeProjectSurface } from "../test/state-harness.js";
import type { GitExecutor } from "../git/exec.js";
import { createProductionServiceFactory } from "./services.js";

const VALID_COMMIT = requireFullCommitSha("0f2c8f4a1d6b4f1e9c2d8e6a5b4c3d2e1f0a9b8c");
const REPOSITORY = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");

function emptyBrowserBundle(): AdviserBrowserBundle {
  return {
    runtime: {} as AdviserBrowserBundle["runtime"],
    loginPort: {} as AdviserBrowserBundle["loginPort"],
    projectSurface: {} as AdviserBrowserBundle["projectSurface"],
    profile: {} as AdviserBrowserBundle["profile"],
  };
}

function fakeGit(): GitExecutor {
  return {
    run: () => Promise.resolve(VALID_COMMIT),
    runAllowingFailure: () => Promise.resolve({ code: 0, stdout: VALID_COMMIT, stderr: "" }),
  };
}

function fakeRuntime(): AdviserBrowserRuntime {
  const models: readonly ModelOption[] = [{ modelId: "gpt-5", displayName: "GPT-5", available: true }];
  const status: RuntimeStatus = {
    phase: "ready",
    processAlive: true,
    headed: false,
    profileDir: "/tmp/pwc-test-profile",
    launchCount: 1,
    humanAttentionRequired: false,
  };
  return {
    status: () => Promise.resolve(status),
    ensureReady: () => Promise.resolve({ ok: true }),
    probeSurface: (): Promise<SurfaceObservation> => Promise.resolve({ state: "conversation-ready", actionable: true }),
    discoverModels: () => Promise.resolve({ ok: true, models }),
    consult: async (request: ConsultationRequest): Promise<ConsultationOutcome> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return {
        ok: true,
        text: `ADVISOR\nconsultation: ${request.consultationId}\nreviewed_commit: ${VALID_COMMIT}\nstatus: actionable\n\nAdviser answer: serialized.`,
        elapsedMs: 5,
      };
    },
    shutdown: () => Promise.resolve(),
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

  it("serializes browser transactions across engines created for different workspaces", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pwc-shared-transaction-"));
    const projectSurface = fakeProjectSurface();
    const runtime = fakeRuntime();
    let activeTransactions = 0;
    let maxActiveTransactions = 0;
    const serial = createBrowserTransactionScheduler();
    const browserTransaction = {
      runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => {
        return await serial.runExclusive(async () => {
          activeTransactions += 1;
          maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
          try {
            return await operation();
          } finally {
            activeTransactions -= 1;
          }
        });
      },
    };
    try {
      const factory = createProductionServiceFactory({
        config: DEFAULT_CONFIG,
        statePaths: {
          stateRoot,
          browserRoot: `${stateRoot}/pi-with-chatgpt/browser`,
          profileDir: `${stateRoot}/pi-with-chatgpt/browser/chatgpt-profile`,
          chromeImportDir: `${stateRoot}/pi-with-chatgpt/browser/chrome-imports`,
          capabilityStateFile: `${stateRoot}/pi-with-chatgpt/browser/capability.json`,
          diagnosticsDir: `${stateRoot}/pi-with-chatgpt/browser/diagnostics`,
        },
        git: fakeGit(),
        browserTransaction,
        browserFactory: () => Promise.resolve({
          runtime,
          loginPort: {} as AdviserBrowserBundle["loginPort"],
          githubConnectorProbe: () => Promise.resolve("verified" as const),
          projectSurface: projectSurface.surface,
          profile: {} as AdviserBrowserBundle["profile"],
        }),
      });

      const [first, second] = await Promise.all([factory("/workspace-a"), factory("/workspace-b")]);
      const [firstResult, secondResult] = await Promise.all([
        first.engine.submitSync({
          anchor: {
            repository: REPOSITORY,
            remoteUrl: "git@github.com:SaehwanPark/pi-with-chatgpt.git",
            requestedRef: "HEAD",
            resolvedCommit: VALID_COMMIT,
            remoteAvailability: { status: "available" },
          },
          branch: "main",
          taskId: "workspace-a-task",
          kind: "consult",
          prompt: "workspace A",
          modelPreference: ["auto-best"],
        }),
        second.engine.submitSync({
          anchor: {
            repository: REPOSITORY,
            remoteUrl: "git@github.com:SaehwanPark/pi-with-chatgpt.git",
            requestedRef: "HEAD",
            resolvedCommit: VALID_COMMIT,
            remoteAvailability: { status: "available" },
          },
          branch: "main",
          taskId: "workspace-b-task",
          kind: "consult",
          prompt: "workspace B",
          modelPreference: ["auto-best"],
        }),
      ]);

      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);
      expect(maxActiveTransactions).toBe(1);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses a second workspace whose browser-level configuration differs", async () => {
    let browserFactoryCalls = 0;
    const factory = createProductionServiceFactory({
      config: DEFAULT_CONFIG,
      configFactory: (cwd) => Promise.resolve(
        cwd === "/workspace-a" ? DEFAULT_CONFIG : { ...DEFAULT_CONFIG, pollIntervalMs: DEFAULT_CONFIG.pollIntervalMs + 1_000 },
      ),
      statePaths: {
        stateRoot: "/tmp/pwc-config-isolation",
        browserRoot: "/tmp/pwc-config-isolation/pi-with-chatgpt/browser",
        profileDir: "/tmp/pwc-config-isolation/pi-with-chatgpt/browser/chatgpt-profile",
        chromeImportDir: "/tmp/pwc-config-isolation/pi-with-chatgpt/browser/chrome-imports",
        capabilityStateFile: "/tmp/pwc-config-isolation/pi-with-chatgpt/browser/capability.json",
        diagnosticsDir: "/tmp/pwc-config-isolation/pi-with-chatgpt/browser/diagnostics",
      },
      browserFactory: () => {
        browserFactoryCalls += 1;
        return Promise.resolve(emptyBrowserBundle());
      },
    });

    await factory("/workspace-a");
    await expect(factory("/workspace-b")).rejects.toThrow(/browser configuration differs/u);
    expect(browserFactoryCalls).toBe(1);
  });
});
