/**
 * M3 — the real {@link AdviserPageDriver}, backed by Playwright driving the system Chrome.
 *
 * This file is intentionally the thinnest layer in the browser runtime: everything worth asserting lives in
 * `runtime.ts` (lifecycle) and `chatgpt-dom.ts` (classification) and is tested against fakes and pure
 * functions. What lives here is the unavoidable glue — launching Chrome against the extension-owned
 * profile, resolving a selector set against a moving DOM, typing a prompt, and reading a turn.
 *
 * Playwright is imported *structurally* (`import type`) so that importing this module never launches a
 * browser and unit tests never need the runtime; the concrete object is injected by
 * {@link createPlaywrightDriverFactory}. The consequence is that this file has no top-level Playwright
 * side effect, which is what lets the Pi extension import it at load time for free.
 *
 * Isolation (INV-11) is not re-implemented here: `userDataDir` is produced by `createAdviserProfile`, which
 * already refuses the user's own Chrome profile. This driver trusts that and refuses to invent a directory
 * of its own.
 */
import {
  CHATGPT_SELECTORS,
  CHATGPT_URLS,
  assistantAnswerIsNew,
  classifySurface,
  classifyTurn,
  modelMatchesLabel,
  scrubPageText,
  type SurfaceSnapshot,
} from "./chatgpt-dom.js";
import type { AdviserProfile } from "./profile.js";
import type {
  AdviserPageDriver,
  ConsultationOutcome,
  ConsultationRequest,
  ModelOption,
  RuntimeStartOptions,
  SurfaceObservation,
} from "./runtime-types.js";

// Structural Playwright types only: no import that could launch a browser at module load.
type BrowserContext = {
  pages(): readonly AdviserPlaywrightPage[];
  newPage(): Promise<AdviserPlaywrightPage>;
  close(): Promise<void>;
};
type AdviserPlaywrightPage = {
  isClosed(): boolean;
  url(): string;
  title(): Promise<string>;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForLoadState(state: string, options: { timeout: number }): Promise<unknown>;
  locator(selector: string): AdviserLocator;
  keyboard: { press(key: string): Promise<void> };
  frames(): readonly { locator(selector: string): AdviserLocator }[];
  close(): Promise<void>;
};
type AdviserElement = {
  isVisible(): Promise<boolean>;
  innerText(): Promise<string>;
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  pressSequentially(text: string, options: { delay: number }): Promise<void>;
};
type AdviserLocator = {
  count(): Promise<number>;
  nth(index: number): AdviserElement;
  first(): AdviserElement;
};

/** A stable page handle: the driver keeps one tab and reuses it. */
type TrackedPage = AdviserPlaywrightPage;

export interface PlaywrightLaunchResult {
  readonly context: BrowserContext;
  readonly chromeVersion: string;
}

/**
 * Injected so the type-checker, the unit tests, and this module all agree without this file importing
 * Playwright at load time. The Pi extension wires the real implementation.
 */
export type PlaywrightLauncher = (options: {
  readonly userDataDir: string;
  readonly headless: boolean;
  readonly channel: string;
  readonly timeoutMs: number;
}) => Promise<PlaywrightLaunchResult>;

export interface PlaywrightDriverOptions {
  readonly profile: AdviserProfile;
  readonly launch: PlaywrightLauncher;
  /** Playwright channel for the system Chrome; `"chrome"` selects the installed Google Chrome. */
  readonly channel?: string;
  readonly navigationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Injection point for tests; real runs use wall-clock timers. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class PlaywrightAdviserDriver implements AdviserPageDriver {
  readonly #profile: AdviserProfile;
  readonly #launch: PlaywrightLauncher;
  readonly #channel: string;
  readonly #navigationTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  #context: BrowserContext | undefined;
  #page: TrackedPage | undefined;
  #chromeVersion = "unknown";

  constructor(options: PlaywrightDriverOptions) {
    this.#profile = options.profile;
    this.#launch = options.launch;
    this.#channel = options.channel ?? "chrome";
    this.#navigationTimeoutMs = options.navigationTimeoutMs ?? 45_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 750;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async start(options: RuntimeStartOptions): Promise<{ readonly chromeVersion: string }> {
    if (this.#context && this.#page && !this.#page.isClosed()) {
      return { chromeVersion: this.#chromeVersion };
    }
    // One tab, reused. launchPersistentContext is what keeps every cookie the adviser gains inside the
    // extension-owned directory (INV-11/INV-12); there is no code path here that touches the user profile.
    // `headless` follows the caller's `headed` flag: a manual login MUST show a window (INV-11 needs a
    // human to type), while a probe stays headless. Default is headless — a window is the deliberate choice.
    const { context, chromeVersion } = await this.#launch({
      userDataDir: this.#profile.userDataDir,
      headless: options.headed !== true,
      channel: this.#channel,
      timeoutMs: this.#navigationTimeoutMs,
    });
    this.#context = context;
    this.#chromeVersion = chromeVersion;
    const existing = context.pages()[0];
    this.#page = existing ?? (await context.newPage());
    return { chromeVersion };
  }

  async isHealthy(): Promise<boolean> {
    if (!this.#context || !this.#page || this.#page.isClosed()) return false;
    try {
      // A cheap round-trip: a hung renderer passes isClosed() but fails to answer a title read.
      await Promise.race([this.#page.title(), this.#sleep(3_000).then(() => "timeout" as const)]);
      return true;
    } catch {
      return false;
    }
  }

  async resetTab(): Promise<void> {
    if (!this.#context) return;
    for (const page of this.#context.pages()) {
      if (page !== this.#page && !page.url().startsWith("chrome://")) {
        await page.close().catch(() => undefined);
      }
    }
    if (!this.#page || this.#page.isClosed()) {
      this.#page = await this.#context.newPage();
    }
  }

  async observeSurface(): Promise<SurfaceObservation> {
    const snapshot = await this.#snapshot();
    return toObservation(snapshot);
  }

  async openChatGPT(): Promise<SurfaceObservation> {
    const page = await this.#requirePage();
    if (hostIsChatGpt(page.url())) {
      // Already on the surface: read what is there instead of reloading and losing a partial state.
      return toObservation(await this.#snapshot());
    }
    await page.goto(CHATGPT_URLS.home, { waitUntil: "domcontentloaded", timeout: this.#navigationTimeoutMs });
    await page.waitForLoadState("load", { timeout: this.#navigationTimeoutMs }).catch(() => undefined);
    return toObservation(await this.#snapshot());
  }

  async listModels(): Promise<readonly ModelOption[]> {
    const page = await this.#requirePage();
    const picker = await firstVisible(page, CHATGPT_SELECTORS.modelPicker);
    if (!picker) return [];
    const current = await safeText(picker.first());
    // Read the picker's own labels; a closed menu yields only the current model, which is still a valid
    // one-option answer rather than an empty list that would look like "no models exist".
    await picker.first().click().catch(() => undefined);
    const options: ModelOption[] = [];
    for (const option of await visibleTexts(page, CHATGPT_SELECTORS.modelOption)) {
      if (option.trim().length > 0) options.push({ modelId: option.trim(), displayName: option.trim(), available: true });
    }
    if (options.length === 0 && current.trim().length > 0) {
      options.push({ modelId: current.trim(), displayName: current.trim(), available: true });
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return options;
  }

  async selectModel(modelId: string): Promise<boolean> {
    const page = await this.#requirePage();
    const picker = await firstVisible(page, CHATGPT_SELECTORS.modelPicker);
    if (!picker) return false;
    if (modelMatchesLabel(modelId, await safeText(picker.first()))) return true;

    await picker.first().click().catch(() => undefined);
    for (const candidate of CHATGPT_SELECTORS.modelOption) {
      const option = page.locator(`${candidate}:has-text("${modelLabelFragment(modelId)}")`);
      if ((await option.count().catch(() => 0)) > 0) {
        await option.first().click().catch(() => undefined);
        // Confirm by re-reading the picker, never by assuming the click landed.
        return modelMatchesLabel(modelId, await safeText((await firstVisible(page, CHATGPT_SELECTORS.modelPicker))?.first()));
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  async askAndAwaitTurn(request: ConsultationRequest): Promise<ConsultationOutcome> {
    const started = Date.now();
    const page = await this.#requirePage();

    const composer = await firstVisible(page, CHATGPT_SELECTORS.composer);
    if (!composer) return { ok: false, failure: "composer-missing" };

    // A prior answer is on screen the moment we type; the turn is ours only when *our* message appears and
    // the thread grows an answer, so the count is taken here, before anything is typed.
    const assistantCountBefore = await countVisible(page, CHATGPT_SELECTORS.assistantMessage);

    await composer.first().click().catch(() => undefined);
    await composer.first().pressSequentially(request.prompt, { delay: 4 }).catch(async () => {
      // Sequenced typing fails on some accessible textboxes; fill() is the fallback.
      await composer.first().fill(request.prompt).catch(() => undefined);
    });

    const send = await firstVisible(page, CHATGPT_SELECTORS.sendButton);
    if (send) await send.first().click().catch(() => page.keyboard.press("Enter"));
    else await page.keyboard.press("Enter");

    const deadline = started + (request.timeoutMs ?? 180_000);
    let sawOwnMessage = false;
    while (Date.now() < deadline) {
      const snapshot = await this.#snapshot();
      const ownMessageVisible = (await firstVisible(page, CHATGPT_SELECTORS.userMessage)) !== undefined;
      sawOwnMessage = sawOwnMessage || ownMessageVisible;
      const assistantCountNow = await countVisible(page, CHATGPT_SELECTORS.assistantMessage);
      const verdict = classifyTurn({
        snapshot,
        sent: true,
        sawOwnMessage,
        sawAssistantMessage: assistantAnswerIsNew(assistantCountBefore, assistantCountNow),
        ...(snapshot.errorNotice === undefined ? {} : { errorNotice: snapshot.errorNotice }),
      });
      if (verdict === "error") {
        return { ok: false, failure: snapshot.showsVerification ? "needs-human" : "provider-error" };
      }
      if (verdict === "complete") {
        const text = await this.#readLatestAnswer(page);
        if (text === undefined) return { ok: false, failure: "response-unreadable" };
        return { ok: true, text, elapsedMs: Date.now() - started };
      }
      await this.#sleep(this.#pollIntervalMs);
    }
    return { ok: false, failure: "generation-timeout" };
  }

  async shutdown(): Promise<void> {
    const context = this.#context;
    this.#context = undefined;
    this.#page = undefined;
    if (context) await context.close().catch(() => undefined);
  }

  async #requirePage(): Promise<TrackedPage> {
    if (!this.#page || this.#page.isClosed()) {
      if (!this.#context) throw new Error("browser not started");
      this.#page = await this.#context.newPage();
    }
    return this.#page;
  }

  /**
   * Read the structural facts the classifier needs. Deliberately presence-only: the DOM is untrusted and
   * nothing here scrapes input values, cookies, or full page text (INV-05/INV-12).
   */
  async #snapshot(): Promise<SurfaceSnapshot> {
    const page = await this.#requirePage();
    const [composer, send, assistant, generating, signIn, verification, error] = await Promise.all([
      firstVisible(page, CHATGPT_SELECTORS.composer),
      firstVisible(page, CHATGPT_SELECTORS.sendButton),
      firstVisible(page, CHATGPT_SELECTORS.assistantMessage),
      firstVisible(page, CHATGPT_SELECTORS.generating),
      firstVisible(page, CHATGPT_SELECTORS.signInPrompt),
      this.#firstVisibleAcrossFrames(page, CHATGPT_SELECTORS.verification),
      firstVisible(page, CHATGPT_SELECTORS.errorNotice),
    ]);
    const errorNotice = error ? scrubPageText(await safeText(error.first())) : undefined;
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      hasComposer: composer !== undefined,
      hasSendButton: send !== undefined,
      hasAssistantMessage: assistant !== undefined,
      isGenerating: generating !== undefined,
      showsSignInPrompt: signIn !== undefined,
      showsVerification: verification !== undefined,
      ...(errorNotice === undefined || errorNotice.length === 0 ? {} : { errorNotice }),
    };
  }

  async #firstVisibleAcrossFrames(page: TrackedPage, selectors: readonly string[]): Promise<AdviserLocator | undefined> {
    // Cloudflare renders the challenge in a nested frame; the main frame cannot see it. `page` itself
    // satisfies the same `{ locator }` shape as a frame, so it heads the list.
    const scopes: readonly { locator(selector: string): AdviserLocator }[] = [page, ...page.frames()];
    for (const scope of scopes) {
      const found = await firstVisible(scope, selectors);
      if (found) return found;
    }
    return undefined;
  }

  async #readLatestAnswer(page: TrackedPage): Promise<string | undefined> {
    // Newest, not first. A thread keeps every earlier answer, so the first assistant node is the oldest
    // advice in the conversation; reading it would attribute yesterday's answer to this consultation.
    const assistant = await lastVisible(page, CHATGPT_SELECTORS.assistantMessage);
    if (!assistant) return undefined;
    const text = await safeText(assistant);
    return text.length > 0 ? text : undefined;
  }
}

/**
 * Build a driver factory bound to a launcher. The Pi extension supplies the launcher once at startup so
 * this module never imports Playwright eagerly.
 */
export function createPlaywrightDriverFactory(
  launch: PlaywrightLauncher,
): (profile: AdviserProfile) => AdviserPageDriver {
  return (profile) => new PlaywrightAdviserDriver({ profile, launch });
}

function toObservation(snapshot: SurfaceSnapshot): SurfaceObservation {
  const classified = classifySurface(snapshot);
  return {
    state: classified.state,
    explanation: classified.explanation,
    actionable: classified.actionable,
  };
}

/**
 * Resolve the first selector in a set that matches a *visible* element.
 *
 * Two layers of robustness, both earned against the live DOM: the fallback order survives a renamed test
 * id, and within a selector we scan the matched elements for the first visible one rather than trusting
 * element [0]. ChatGPT ships many hidden duplicate controls (mobile menus, portals); a selector can match
 * fourteen nodes whose first is invisible while a later one is the real, clickable control. Checking only
 * `.first()` made a genuinely present control read as absent.
 */
/** How many matched elements a single probe will check for visibility. */
const VISIBLE_SCAN_CAP = 12;

async function firstVisible(page: { locator(s: string): AdviserLocator }, selectors: readonly string[]): Promise<AdviserLocator | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    // Cap the scan: a runaway selector match should not turn a probe into a hundred visibility checks.
    for (let index = 0; index < Math.min(count, VISIBLE_SCAN_CAP); index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) return locator;
    }
  }
  return undefined;
}

/**
 * The last element a selector set matches that is visible, newest end first.
 *
 * The mirror of {@link firstVisible} and needed for a different question. Presence asks "is this control
 * anywhere on the page", where any match answers it; reading an answer asks "which turn did we just
 * cause", where the first match is the *oldest* one in the thread. Scanning backwards from the end is
 * what makes the newest answer the one we return.
 */
async function lastVisible(page: { locator(s: string): AdviserLocator }, selectors: readonly string[]): Promise<AdviserElement | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = count - 1; index >= 0 && index > count - 1 - VISIBLE_SCAN_CAP; index -= 1) {
      const element = locator.nth(index);
      if (await element.isVisible().catch(() => false)) return element;
    }
  }
  return undefined;
}

/**
 * How many elements a selector set matches that are visible, using the first selector that matches.
 *
 * A count rather than a boolean because turn completion is a *change* in count: a conversation that
 * already had an answer on screen stays "has an answer" across the whole of the next turn.
 */
async function countVisible(page: { locator(s: string): AdviserLocator }, selectors: readonly string[]): Promise<number> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    let visible = 0;
    for (let index = 0; index < Math.min(count, VISIBLE_SCAN_CAP); index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
    }
    if (visible > 0) return visible;
  }
  return 0;
}

async function visibleTexts(page: { locator(s: string): AdviserLocator }, selectors: readonly string[]): Promise<string[]> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if ((await locator.count().catch(() => 0)) > 0) {
      const text = await locator.first().innerText().catch(() => "");
      if (text.trim().length > 0) return text.split("\n");
    }
  }
  return [];
}

async function safeText(node: { innerText(): Promise<string> } | undefined): Promise<string> {
  if (!node) return "";
  return (await node.innerText().catch(() => "")).trim();
}

/** `gpt-5.5` becomes a fragment tolerant of the display form. */
function modelLabelFragment(modelId: string): string {
  const normalized = modelId.toLowerCase().replace(/^gpt-?/u, "");
  return normalized.length > 0 ? normalized : modelId;
}

function hostIsChatGpt(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com";
  } catch {
    return false;
  }
}
