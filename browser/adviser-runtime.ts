/**
 * M3 composition root — the one place that binds Playwright to the browser runtime and to the M2 login
 * port. This is the only module in the browser tree that imports `playwright-core` eagerly; everything
 * else reaches Chrome through the {@link AdviserPageDriver} seam so it stays testable.
 *
 * Two things are wired here:
 *
 * - **The runtime**: an {@link AdviserRuntime} over a {@link PlaywrightAdviserDriver}, rooted at the
 *   extension-owned profile the M2 profile module already isolated. The launcher passes only that profile
 *   directory to `launchPersistentContext`, so isolation is inherited, not re-derived (INV-11).
 * - **The login port**: an implementation of M2's {@link AdviserLoginPort} on top of the driver. Like the
 *   port itself, it has *no* click/type/navigate/solve surface — `open` shows a headed window, `observe`
 *   reads whether a session exists, `seal` flushes storage after success. A human signs in; nothing here
 *   can automate it (INV-11).
 *
 * Headed vs headless is decided by purpose: capability probes and consultations run headless; a manual
 * login must show a window or the person has nothing to type into.
 */
import { chromium, type BrowserContext } from "playwright-core";

import type { AdviserLoginPort, SessionObservation } from "../auth/login-flow.js";
import { adviserProfileFor, prepareStateStorage, type StateStoragePaths } from "./state-storage.js";
import { createPlaywrightDriverFactory, type PlaywrightLauncher } from "./playwright-driver.js";
import { AdviserRuntime } from "./runtime.js";
import type { AdviserBrowserRuntime, SurfaceState } from "./runtime-types.js";
import type { AdviserProfile } from "./profile.js";

/**
 * The real launcher. Isolation comes entirely from `userDataDir`, which the caller obtained from
 * `adviserProfileFor` and which `createAdviserProfile` already refused to point at a user browser profile.
 */
const launchChrome: PlaywrightLauncher = async ({ userDataDir, headless, channel, timeoutMs }) => {
  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    channel,
    headless,
    timeout: timeoutMs,
    // A clean viewport with no automation markers: ChatGPT behaves the same as for a real window, and we
    // are not trying to evade a check — only to avoid a window that would confuse the user.
    viewport: { width: 1280, height: 900 },
  });
  const version = context.browser()?.version() ?? "unknown";
  return { context: context as unknown as PlaywrightLaunchContext, chromeVersion: version };
};

/** Structural alias so the eager import does not leak Playwright's exact context type across the seam. */
type PlaywrightLaunchContext = Awaited<ReturnType<PlaywrightLauncher>>["context"];

const driverFor = createPlaywrightDriverFactory(launchChrome);

export interface AdviserBrowserBundle {
  readonly runtime: AdviserBrowserRuntime;
  readonly loginPort: AdviserLoginPort;
  readonly profile: AdviserProfile;
}

/**
 * Build the runtime for a repository's adviser profile, preparing the on-disk state first.
 *
 * `prepareStateStorage` is called here rather than at import time so the filesystem is only touched when a
 * consultation or status command actually needs the browser.
 */
export async function createAdviserBrowser(paths: StateStoragePaths): Promise<AdviserBrowserBundle> {
  await prepareStateStorage(paths);
  const profile = adviserProfileFor(paths);
  const driver = driverFor(profile);
  const runtime = new AdviserRuntime({ driver, profileDir: profile.userDataDir });
  return { runtime, loginPort: loginPortFor(profile, runtime), profile };
}

/**
 * Implement the M2 login port against the runtime.
 *
 * The port is defined by its limitations and this implementation honours them literally: to open a window
 * it ensures a *headed* browser and loads ChatGPT; to observe a session it reads the surface and maps the
 * four terminal states. There is deliberately no method that could complete a login.
 */
/**
 * Exported for tests: this seam is where M2's login flow meets M3's runtime, and the contract between
 * them (open while signed out, then observe until signed in) is exactly the kind of thing that breaks
 * silently when either side latches state.
 */
export function loginPortFor(profile: AdviserProfile, runtime: AdviserBrowserRuntime): AdviserLoginPort {
  return {
    async openAdviserWindow(_profile: AdviserProfile): Promise<void> {
      // Headed on purpose: a background window a person cannot see or type into is not a login path.
      const ready = await runtime.ensureReady({ purpose: "manual-login", headed: true });
      if (!ready.ok) throw new Error(`could not open the adviser window (${ready.rejection ?? "unknown"})`);
      // Probing the surface navigates to ChatGPT if the runtime is not already there.
      await runtime.probeSurface();
    },
    async observeSession(_profile: AdviserProfile): Promise<SessionObservation> {
      const observation = await runtime.probeSurface();
      return toSessionObservation(observation.state, observation.explanation);
    },
    // Nothing to flush explicitly: launchPersistentContext persists the profile on close, and the manual
    // login flow seals before it reports success. This method exists so the flow's contract is honoured.
    async sealSession(_profile: AdviserProfile): Promise<void> {
      const status = await runtime.status();
      if (status.phase === "stopped") throw new Error("cannot seal a session on a stopped browser");
    },
  };
}

/** Map a surface state onto the login flow's terminal observation set. */
export function toSessionObservation(state: SurfaceState, explanation?: string): SessionObservation {
  switch (state) {
    case "signed-out":
      return { kind: "signed-out" };
    case "human-verification":
      return { kind: "human-verification", challenge: classifyChallenge(explanation) };
    case "conversation-ready":
    case "generating":
    case "response-complete":
      return { kind: "signed-in" };
    default:
      // "unknown" and provider errors are not proof of either state; report unreachable so the flow keeps
      // polling on its own schedule rather than declaring success or a challenge it did not see.
      return { kind: "unreachable", reason: "network" };
  }
}

function classifyChallenge(explanation: string | undefined): "cloudflare" | "captcha" | "login-checkpoint" {
  const text = (explanation ?? "").toLowerCase();
  if (text.includes("cloudflare")) return "cloudflare";
  if (text.includes("captcha")) return "captcha";
  return "login-checkpoint";
}
