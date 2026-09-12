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
}

export interface ProductionServices {
  readonly engine: ConsultationEngine;
  readonly loginPort: AdviserLoginPort;
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
  let browser: Promise<AdviserBrowserBundle> | undefined;
  let browserConfig: AdviserConfig | undefined;

  return async (cwd: string): Promise<ProductionServices> => {
    const workspace = resolve(cwd);
    const existing = servicesByCwd.get(workspace);
    if (existing !== undefined) return await existing;

    const pending = createProductionServices(options, workspace, (config) => {
      if (browser !== undefined) return browser;
      browserConfig = config;
      browser = (options.browserFactory ?? loadAdviserBrowser)(options.statePaths ?? stateStoragePaths(), browserConfig).catch(
        (error: unknown) => {
          browser = undefined;
          throw error;
        },
      );
      return browser;
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
  getBrowser: (config: AdviserConfig) => Promise<AdviserBrowserBundle>,
): Promise<ProductionServices> {
  const config = options.configFactory ? await options.configFactory(cwd) : options.config;
  const paths = options.statePaths ?? stateStoragePaths();
  const layout = adviserStateLayout(paths.stateRoot);
  const git = options.git ?? createGitExecutor(createNodeCommandRunner());
  const ledger = options.ledger ?? new ConsultationLedger({ layout });
  const browser = await getBrowser(config);
  const store = new ConsultationJobStore(layout);

  const engine = new ConsultationEngine({
    layout,
    store,
    surface: browser.projectSurface,
    runtime: browser.runtime,
    ledger,
    // The engine records both dispatch and receipt HEAD.  This remains read-only and deliberately uses
    // the same workspace that produced the immutable checkpoint passed by the manager.
    getHeadCommit: async () => requireFullCommitSha(await git.run(["rev-parse", "--verify", "HEAD^{commit}"], cwd)),
  });

  return { engine, loginPort: browser.loginPort };
}

async function loadAdviserBrowser(paths: StateStoragePaths, config?: AdviserConfig): Promise<AdviserBrowserBundle> {
  // Keep playwright-core out of activation/module-load paths.  The deep module imports it only when a
  // consultation or manual login actually needs the isolated browser.
  const { createAdviserBrowser } = await import("../browser/adviser-runtime.js");
  return await createAdviserBrowser(paths, config);
}
