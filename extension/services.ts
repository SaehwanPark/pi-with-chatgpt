/**
 * Production composition root for adviser services.
 *
 * Activation only registers Pi handlers.  The browser profile, Playwright runtime, job store, and
 * consultation engine are assembled on the first operation that needs them.  Keeping this boundary
 * lazy is important for normal Pi sessions: loading an extension must not create state or launch Chrome,
 * while a missing adviser setup must never turn into a fabricated successful consultation.
 */

import type { AdviserLoginPort } from "../auth/login-flow.js";
import { adviserStateLayout } from "../config/state-layout.js";
import { stateStoragePaths, type StateStoragePaths } from "../browser/state-storage.js";
import type { AdviserBrowserBundle } from "../browser/adviser-runtime.js";
import {
  createConsultationCapabilityGate,
  type GitHubConnectorProbe,
  type ConsultationCapabilityGate,
} from "../browser/consultation-capability.js";
import { createBrowserTransactionScheduler, type BrowserTransactionScheduler } from "../browser/transaction.js";
import type { AdviserConfig } from "../config/schema.js";
import { createGitExecutor, createNodeCommandRunner, type GitExecutor } from "../git/exec.js";
import { ConsultationLedger } from "../ledger/ledger.js";
import { ConsultationEngine } from "../jobs/engine.js";
import { ConsultationJobStore } from "../jobs/store.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import { resolve } from "node:path";

export interface ProductionServiceOptions {
  readonly config: AdviserConfig;
  /** Loaded lazily per workspace; explicit `config` remains the safe fallback for embedded callers. */
  readonly configFactory?: (cwd: string) => Promise<AdviserConfig>;
  /** Test seam and an opportunity for callers that already own a read-only git executor. */
  readonly git?: GitExecutor;
  /** Test seam for keeping the service graph on the same ledger as a manager. */
  readonly ledger?: ConsultationLedger;
  /** Test seam; production uses the dynamic browser import below. */
  readonly browserFactory?: (paths: StateStoragePaths, config?: AdviserConfig) => Promise<AdviserBrowserBundle>;
  /** Test seam for state isolation; production derives Pi's state path. */
  readonly statePaths?: StateStoragePaths;
  /** Test seam; production creates one scheduler per extension activation. */
  readonly browserTransaction?: BrowserTransactionScheduler;
  /** Reviewed extension-owned connector capability probe; absent means fail closed as unverified. */
  readonly githubConnectorProbe?: GitHubConnectorProbe;
}

export interface ProductionServices {
  readonly engine: ConsultationEngine;
  readonly loginPort: AdviserLoginPort;
  /** The same gate used by explicit preflight and the engine's final dispatch boundary. */
  readonly capabilityGate: ConsultationCapabilityGate;
}

export type ProductionServiceFactory = (cwd: string) => Promise<ProductionServices>;

/**
 * Create a process-scoped, shared service factory.
 *
 * The first caller establishes the Pi workspace used by the engine's receipt HEAD probe.  A Pi process
 * owns one extension instance and one workspace, so sharing one engine also guarantees one browser
 * profile/runtime and one Project-surface lock across commands and tools.
 */
export function createProductionServiceFactory(options: ProductionServiceOptions): ProductionServiceFactory {
  const servicesByCwd = new Map<string, Promise<ProductionServices>>();
  const browserTransaction = options.browserTransaction ?? createBrowserTransactionScheduler();
  let browser: Promise<AdviserBrowserBundle> | undefined;
  let browserConfig: AdviserConfig | undefined;
  let browserConfigKey: string | undefined;
  let loginPort: AdviserLoginPort | undefined;

  return async (cwd: string): Promise<ProductionServices> => {
    const workspace = resolve(cwd);
    const existing = servicesByCwd.get(workspace);
    if (existing !== undefined) return await existing;

    const pending = createProductionServices(options, workspace, browserTransaction, (config) => {
      const configKey = sharedBrowserConfigKey(config);
      if (browser !== undefined) {
        // A single tracked browser cannot honor two different browser-level configurations. Reusing the
        // first workspace's executable/polling/timeout settings would silently make the second workspace
        // behave differently from its own config, so fail closed instead of allowing config bleed.
        if (browserConfigKey !== configKey) {
          throw new Error("Adviser browser configuration differs between active workspaces; use one shared browser configuration.");
        }
        return browser;
      }
      browserConfig = config;
      browserConfigKey = configKey;
      browser = (options.browserFactory ?? loadAdviserBrowser)(options.statePaths ?? stateStoragePaths(), browserConfig).catch(
        (error: unknown) => {
          browser = undefined;
          browserConfig = undefined;
          browserConfigKey = undefined;
          throw error;
        },
      );
      return browser;
    }, (bundle) => {
      loginPort ??= serializeLoginPort(bundle.loginPort, browserTransaction);
      return loginPort;
    });
    // Cache in-flight promises so simultaneous calls for one workspace cannot create two engines or two
    // browsers. A failed workspace setup is retryable after the user repairs it.
    const services = pending.catch((error: unknown) => {
      servicesByCwd.delete(workspace);
      throw error;
    });
    servicesByCwd.set(workspace, services);
    return await services;
  };
}

async function createProductionServices(
  options: ProductionServiceOptions,
  cwd: string,
  browserTransaction: BrowserTransactionScheduler,
  getBrowser: (config: AdviserConfig) => Promise<AdviserBrowserBundle>,
  getLoginPort: (bundle: AdviserBrowserBundle) => AdviserLoginPort,
): Promise<ProductionServices> {
  const config = options.configFactory ? await options.configFactory(cwd) : options.config;
  const paths = options.statePaths ?? stateStoragePaths();
  const layout = adviserStateLayout(paths.stateRoot);
  const git = options.git ?? createGitExecutor(createNodeCommandRunner());
  const ledger = options.ledger ?? new ConsultationLedger({ layout });
  const browser = await getBrowser(config);
  const store = new ConsultationJobStore(layout);
  const capabilityGate = createConsultationCapabilityGate({
    runtime: browser.runtime,
    githubConnectorProbe: options.githubConnectorProbe ?? browser.githubConnectorProbe,
    browserTransaction,
  });

  const engine = new ConsultationEngine({
    layout,
    store,
    surface: browser.projectSurface,
    runtime: browser.runtime,
    ledger,
    browserTransaction,
    capabilityGate,
    // The engine records both dispatch and receipt HEAD.  This remains read-only and deliberately uses
    // the same workspace that produced the immutable checkpoint passed by the manager.
    getHeadCommit: async () => requireFullCommitSha(await git.run(["rev-parse", "--verify", "HEAD^{commit}"], cwd)),
  });

  return { engine, loginPort: getLoginPort(browser), capabilityGate };
}

/**
 * Only these settings are consumed while constructing the shared browser bundle. Consultation behavior
 * (dependency, mode, and auto-consult) remains workspace-local and is resolved by the command/tool
 * manager; browser-level settings must agree because there is only one process-wide tab.
 */
function sharedBrowserConfigKey(config: AdviserConfig): string {
  return JSON.stringify({
    browserExecutablePath: config.browserExecutablePath ?? null,
    pollIntervalMs: config.pollIntervalMs,
    syncTimeoutMs: config.syncTimeoutMs,
  });
}

/** Keep manual login operations from navigating the shared tab during an engine transaction. */
function serializeLoginPort(
  port: AdviserLoginPort,
  scheduler: BrowserTransactionScheduler,
): AdviserLoginPort {
  return {
    openAdviserWindow: (profile) => scheduler.runExclusive(() => port.openAdviserWindow(profile)),
    observeSession: (profile) => scheduler.runExclusive(() => port.observeSession(profile)),
    sealSession: (profile) => scheduler.runExclusive(() => port.sealSession(profile)),
  };
}

async function loadAdviserBrowser(paths: StateStoragePaths, config?: AdviserConfig): Promise<AdviserBrowserBundle> {
  // Keep playwright-core out of activation/module-load paths.  The deep module imports it only when a
  // consultation or manual login actually needs the isolated browser.
  const { createAdviserBrowser } = await import("../browser/adviser-runtime.js");
  return await createAdviserBrowser(paths, config);
}
