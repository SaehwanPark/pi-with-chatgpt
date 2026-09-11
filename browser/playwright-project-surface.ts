/**
 * M4 — the ChatGPT Project / conversation surface, driven through the page the M3 runtime already owns.
 *
 * This is the thinnest layer that can be written, for the reason M3 established: the decisions
 * (is this Project present, is this card a Project, is this chat gone) are pure functions in
 * `chatgpt-dom.ts` and are tested there; this file only turns selectors into booleans and strings.
 *
 * Two hard rules:
 *
 * - **No invented identity.** A Project or conversation id is accepted only when ChatGPT shows it in a
 *   link or the address bar. If it cannot be read, the operation fails with `surface-unrecognised`; the
 *   caller never gets a plausible-looking id, because a wrong id means advice filed against the wrong
 *   thread (INV-08, INV-09).
 * - **Every wait is bounded.** Each navigation polls for a known control up to `timeoutMs` and then
 *   reports what it saw. Nothing here blocks a consultation on a page that stopped answering.
 */

import {
  CHATGPT_SELECTORS,
  CHATGPT_URLS,
  classifyConversationPresence,
  classifyProjectPresence,
  classifySurface,
  findProjectByTitle,
  isChatGptSurfaceUrl,
  parseConversationIdFromHref,
  parseProjectEntries,
  parseProjectIdFromHref,
  scrubPageText,
  type ProjectEntry,
  type SurfaceSnapshot,
} from "./chatgpt-dom.js";
import type {
  AdviserProjectSurface,
  ConversationInspection,
  ConversationStartResult,
  ProjectCreationResult,
  ProjectInspection,
  ProjectListResult,
} from "./runtime-types.js";

/** Structural Playwright subset: the real objects satisfy it, the tests supply a fake. */
export interface ProjectSurfaceElement {
  isVisible(): Promise<boolean>;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  click(): Promise<void>;
  fill(text: string): Promise<void>;
}

export interface ProjectSurfaceLocator {
  count(): Promise<number>;
  nth(index: number): ProjectSurfaceElement;
  first(): ProjectSurfaceElement;
}

export interface ProjectSurfaceFrame {
  url(): string;
  locator(selector: string): ProjectSurfaceLocator;
}

export interface ProjectSurfacePage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options: { readonly waitUntil: string; readonly timeout: number }): Promise<unknown>;
  locator(selector: string): ProjectSurfaceLocator;
  frames(): readonly ProjectSurfaceFrame[];
}

export interface PlaywrightProjectSurfaceOptions {
  /** The runtime's single tracked tab; this module never opens a second one. */
  readonly page: () => Promise<ProjectSurfacePage>;
  /** Driver-owned lock shared with consultation/login/model operations on the same tracked tab. */
  readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

  /** Cards scraped before the list settles are a partial truth, so the list is bounded and re-read once. */
const MAX_PROJECT_CARDS = 60;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_MS = 250;

interface ProjectCardScrape {
  readonly found: boolean;
  readonly entries: readonly ProjectEntry[];
}

interface ProjectSurfaceScope {
  readonly locator: (selector: string) => ProjectSurfaceLocator;
}

export function createPlaywrightProjectSurface(
  options: PlaywrightProjectSurfaceOptions,
): AdviserProjectSurface {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let surfaceTail: Promise<void> = Promise.resolve();
  const runExclusive = options.runExclusive ?? withSurfaceLock;

  async function firstVisible(page: ProjectSurfacePage, selectors: readonly string[]): Promise<ProjectSurfaceElement | undefined> {
    for (const frame of pageScopes(page)) {
      for (const selector of selectors) {
        let locator: ProjectSurfaceLocator;
        try {
          locator = frame.locator(selector);
        } catch {
          continue;
        }
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 12); index += 1) {
          let element: ProjectSurfaceElement;
          try {
            element = locator.nth(index);
          } catch {
            continue;
          }
          if (await element.isVisible().catch(() => false)) return element;
        }
      }
    }
    return undefined;
  }

  async function readSnapshot(page: ProjectSurfacePage): Promise<SurfaceSnapshot> {
    const text = async (selectors: readonly string[]): Promise<boolean> => (await firstVisible(page, selectors)) !== undefined;
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      hasComposer: await text(CHATGPT_SELECTORS.composer),
      hasSendButton: await text(CHATGPT_SELECTORS.sendButton),
      hasAssistantMessage: await text(CHATGPT_SELECTORS.assistantMessage),
      isGenerating: await text(CHATGPT_SELECTORS.generating),
      showsSignInPrompt: await text(CHATGPT_SELECTORS.signInPrompt),
      showsVerification: await text(CHATGPT_SELECTORS.verification),
    };
  }

  /** Navigate and wait for the page to look like *something* we recognise. Never an unbounded wait. */
  async function gotoRecognised(page: ProjectSurfacePage, url: string): Promise<SurfaceSnapshot | undefined> {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch {
      return undefined;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let snapshot: SurfaceSnapshot;
      try {
        snapshot = await readSnapshot(page);
      } catch {
        return undefined;
      }
      const classification = classifySurface(snapshot);
      // The Projects page legitimately has no composer. Project-specific controls therefore count as a
      // recognised ChatGPT surface, but only after the host check: a page-controlled redirect must never
      // become a second navigation or identity source (INV-02).
      if (
        classification.state !== "unknown" ||
        (isChatGptSurfaceUrl(snapshot.url) && (await hasProjectControls(page))) ||
        Date.now() >= deadline
      ) {
        return snapshot;
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  async function scrapeProjectCards(page: ProjectSurfacePage): Promise<ProjectCardScrape> {
    const first = await scrapeProjectCardsOnce(page);
    await sleep(Math.min(pollIntervalMs, timeoutMs));
    const second = await scrapeProjectCardsOnce(page);
    const entries = [...first.entries];
    for (const entry of second.entries) {
      if (!entries.some((candidate) => candidate.projectId === entry.projectId)) entries.push(entry);
    }
    return { found: first.found || second.found, entries };
  }

  async function scrapeProjectCardsOnce(page: ProjectSurfacePage): Promise<ProjectCardScrape> {
    const cards: { href: string | undefined; label: string | undefined }[] = [];
    let found = false;
    for (const frame of pageScopes(page)) {
      for (const selector of CHATGPT_SELECTORS.projectCard) {
        let locator: ProjectSurfaceLocator;
        try {
          locator = frame.locator(selector);
        } catch {
          continue;
        }
        const count = await locator.count().catch(() => 0);
        if (count === 0) continue;
        found = true;
        for (let index = 0; index < Math.min(count, MAX_PROJECT_CARDS); index += 1) {
          let card: ProjectSurfaceElement;
          try {
            card = locator.nth(index);
          } catch {
            continue;
          }
          const href = await card.getAttribute("href").catch(() => null);
          const label = scrubPageText(await card.innerText().catch(() => ""), 200);
          cards.push({ href: href ?? undefined, label });
        }
      }
    }
    return { found, entries: parseProjectEntries(cards) };
  }

  const rawSurface: AdviserProjectSurface = {
    async listProjects(): Promise<ProjectListResult> {
      let page: ProjectSurfacePage;
      try {
        page = await options.page();
      } catch {
        return { ok: false, reason: "browser-lost" };
      }
      const snapshot = await gotoRecognised(page, CHATGPT_URLS.projects);
      if (snapshot === undefined) return { ok: false, reason: "provider-error" };
      const failure = projectSurfaceFailure(snapshot);
      const classification = classifySurface(snapshot);
      if (failure !== undefined && classification.state !== "unknown") return { ok: false, reason: failure };
      if (failure === "surface-unrecognised" && (!isChatGptSurfaceUrl(snapshot.url) || !(await hasProjectControls(page)))) {
        return { ok: false, reason: failure };
      }
      const scraped = await scrapeProjectCards(page);
      if (!scraped.found) {
        // An empty, recognised Projects page still needs a create control. Without one, absence of cards
        // is an unreadable list, not proof that the account has no Projects.
        const create = await firstVisible(page, CHATGPT_SELECTORS.newProject);
        if (create === undefined) return { ok: false, reason: "surface-unrecognised" };
        return { ok: true, projects: [] };
      }
      if (scraped.entries.length === 0) return { ok: false, reason: "surface-unrecognised" };
      return {
        ok: true,
        projects: scraped.entries.map((entry) => ({
          projectId: entry.projectId,
          title: entry.title,
          projectUrl: CHATGPT_URLS.project(entry.projectId),
        })),
      };
    },

    async inspectProject(projectId: string): Promise<ProjectInspection> {
      let page: ProjectSurfacePage;
      try {
        page = await options.page();
      } catch {
        return { state: "unknown", reason: "network" };
      }
      const snapshot = await gotoRecognised(page, CHATGPT_URLS.projects);
      if (snapshot === undefined) return { state: "unknown", reason: "network" };
      const classification = classifySurface(snapshot);
      if (classification.state === "signed-out" || classification.state === "human-verification") {
        return { state: "unknown", reason: "needs-human" };
      }
      if (classification.state === "provider-error") return { state: "unknown", reason: "network" };
      const projectSurfaceRecognised = await hasProjectControls(page);
      const uncertain =
        (classification.state === "unknown" && !projectSurfaceRecognised);
      const scraped = uncertain ? undefined : await scrapeProjectCards(page);
      if (scraped?.found === true && scraped.entries.length === 0) {
        return { state: "unknown", reason: "surface-unrecognised" };
      }
      const entries = scraped?.found === true ? scraped.entries : undefined;
      // A card that names the id is direct evidence, so a Projects list that does not show it is checked
      // against the Project page itself before it is called deleted.
      if (entries !== undefined && entries.some((entry) => entry.projectId === projectId)) {
        const entry = entries.find((candidate) => candidate.projectId === projectId) as ProjectEntry;
        return { state: "present", title: entry.title, projectUrl: CHATGPT_URLS.project(projectId) };
      }
      const verdict = classifyProjectPresence(entries, projectId, {
        signedOut: false,
        loaded: entries !== undefined,
      });
      if (verdict.state !== "gone") return verdict;
      return await inspectProjectPage(page, projectId);
    },

    async createProject(input): Promise<ProjectCreationResult> {
      let page: ProjectSurfacePage;
      try {
        page = await options.page();
      } catch {
        return { ok: false, reason: "browser-lost" };
      }
      const snapshot = await gotoRecognised(page, CHATGPT_URLS.projects);
      if (snapshot === undefined) return { ok: false, reason: "provider-error" };
      const classification = classifySurface(snapshot);
      if (classification.state === "signed-out" || classification.state === "human-verification") {
        return { ok: false, reason: "needs-human" };
      }
      if (classification.state === "provider-error") return { ok: false, reason: "provider-error" };
      if (classification.state === "unknown" && (!isChatGptSurfaceUrl(snapshot.url) || !(await hasProjectControls(page)))) {
        return { ok: false, reason: "surface-unrecognised" };
      }
      const create = await firstVisible(page, CHATGPT_SELECTORS.newProject);
      if (create === undefined) return { ok: false, reason: "surface-unrecognised" };
      try {
        await create.click();
      } catch {
        return { ok: false, reason: "browser-lost" };
      }
      const nameInput = await firstVisible(page, CHATGPT_SELECTORS.projectNameInput);
      if (nameInput === undefined) return { ok: false, reason: "surface-unrecognised" };
      try {
        await nameInput.fill(input.title);
      } catch {
        return { ok: false, reason: "browser-lost" };
      }
      const inlineInstructions = await firstVisible(page, CHATGPT_SELECTORS.projectInstructions);
      if (inlineInstructions !== undefined) {
        try {
          await inlineInstructions.fill(input.instructions);
        } catch {
          return { ok: false, reason: "browser-lost" };
        }
      }
      const save = await firstVisible(page, CHATGPT_SELECTORS.projectSave);
      if (save === undefined) return { ok: false, reason: "surface-unrecognised" };
      try {
        await save.click();
      } catch {
        return { ok: false, reason: "browser-lost" };
      }

      const projectId = await waitForProjectId(page);
      if (projectId !== undefined) {
        return {
          ok: true,
          projectId,
          title: input.title,
          projectUrl: CHATGPT_URLS.project(projectId),
          instructionsApplied: await applyInstructionsOnPage(page, projectId, input.instructions),
        };
      }
      // Creation redirected somewhere without an id in the URL: trust the list, which is also the path
      // where a concurrent creator's Project becomes visible and gets adopted instead of duplicated.
      const scraped = await scrapeProjectCards(page);
      const adopted = scraped.found ? findProjectByTitle(scraped.entries, input.title) : undefined;
      if (adopted !== undefined) {
        return {
          ok: true,
          projectId: adopted.projectId,
          title: adopted.title,
          projectUrl: CHATGPT_URLS.project(adopted.projectId),
          instructionsApplied: await applyInstructionsOnPage(page, adopted.projectId, input.instructions),
        };
      }
      return { ok: false, reason: "surface-unrecognised" };
    },

    async applyInstructions(projectId, instructions): Promise<boolean> {
      try {
        const page = await options.page();
        return await applyInstructionsOnPage(page, projectId, instructions);
      } catch {
        return false;
      }
    },

    async startConversation(projectId): Promise<ConversationStartResult> {
      let page: ProjectSurfacePage;
      try {
        page = await options.page();
      } catch {
        return { ok: false, reason: "browser-lost" };
      }
      const projectUrl = safeProjectUrl(projectId);
      if (projectUrl === undefined) return { ok: false, reason: "surface-unrecognised" };
      const snapshot = await gotoRecognised(page, projectUrl);
      if (snapshot === undefined) return { ok: false, reason: "provider-error" };
      if (!isProjectUrl(snapshot.url, projectId)) return { ok: false, reason: "surface-unrecognised" };
      const classification = classifySurface(snapshot);
      if (classification.state === "signed-out" || classification.state === "human-verification") {
        return { ok: false, reason: "needs-human" };
      }
      if (classification.state === "provider-error") return { ok: false, reason: "provider-error" };
      if (classification.state === "unknown" && (!isChatGptSurfaceUrl(snapshot.url) || !(await hasProjectControls(page)))) {
        return { ok: false, reason: "surface-unrecognised" };
      }
      const newChat = await firstVisible(page, CHATGPT_SELECTORS.projectNewChat);
      if (newChat === undefined) return { ok: false, reason: "surface-unrecognised" };
      const linkedConversation = parseConversationIdFromHref(await newChat.getAttribute("href").catch(() => null) ?? undefined);
      try {
        await newChat.click();
      } catch {
        return { ok: false, reason: "browser-lost" };
      }
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const currentUrl = safePageUrl(page);
        if (currentUrl === undefined) return { ok: false, reason: "browser-lost" };
        const conversationId = parseConversationIdFromHref(currentUrl) ?? linkedConversation;
        if (conversationId !== undefined) {
          return { ok: true, conversationId, conversationUrl: CHATGPT_URLS.conversation(conversationId) };
        }
        if (Date.now() >= deadline) return { ok: false, reason: "surface-unrecognised" };
        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      }
    },

    async inspectConversation(conversationId): Promise<ConversationInspection> {
      let page: ProjectSurfacePage;
      try {
        page = await options.page();
      } catch {
        return { state: "unknown", reason: "network" };
      }
      const conversationUrl = safeConversationUrl(conversationId);
      if (conversationUrl === undefined) return { state: "unknown", reason: "surface-unrecognised" };
      const snapshot = await gotoRecognised(page, conversationUrl);
      if (snapshot === undefined) return { state: "unknown", reason: "network" };
      if (!isConversationUrl(snapshot.url, conversationId)) {
        return { state: "unknown", reason: "surface-unrecognised" };
      }
      const surface = classifySurface(snapshot);
      if (surface.state === "provider-error") return { state: "unknown", reason: "network" };
      const deleted = await firstVisible(page, CHATGPT_SELECTORS.deletedConversation);
      const result = classifyConversationPresence({
        surface: surface.state,
        showsDeletedNotice: deleted !== undefined,
      });
      return result.state === "live"
        ? { ...result, conversationUrl: CHATGPT_URLS.conversation(conversationId) }
        : result;
    },
  };

  // The M3 runtime owns one tracked tab. State locks isolate records, but they do not stop two different
  // task keys from navigating that tab at once; serialize the browser effect while leaving their state
  // operations independently keyed.
  return {
    listProjects: () => runExclusive(() => rawSurface.listProjects()),
    inspectProject: (projectId) => runExclusive(() => rawSurface.inspectProject(projectId)),
    createProject: (input) => runExclusive(() => rawSurface.createProject(input)),
    applyInstructions: (projectId, instructions) => runExclusive(() => rawSurface.applyInstructions(projectId, instructions)),
    startConversation: (projectId) => runExclusive(() => rawSurface.startConversation(projectId)),
    inspectConversation: (conversationId) => runExclusive(() => rawSurface.inspectConversation(conversationId)),
  };

  async function withSurfaceLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = surfaceTail;
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    surfaceTail = tail;
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (surfaceTail === tail) surfaceTail = Promise.resolve();
    }
  }

  async function hasProjectControls(page: ProjectSurfacePage): Promise<boolean> {
    return (
      (await firstVisible(page, CHATGPT_SELECTORS.projectCard)) !== undefined ||
      (await firstVisible(page, CHATGPT_SELECTORS.newProject)) !== undefined ||
      (await firstVisible(page, CHATGPT_SELECTORS.projectInstructions)) !== undefined ||
      (await firstVisible(page, CHATGPT_SELECTORS.projectNewChat)) !== undefined
    );
  }

  async function waitForProjectId(page: ProjectSurfacePage): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const projectId = parseProjectIdFromHref(page.url());
      if (projectId !== undefined) return projectId;
      if (Date.now() >= deadline) return undefined;
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  async function applyInstructionsOnPage(
    page: ProjectSurfacePage,
    projectId: string,
    instructions: string,
  ): Promise<boolean> {
    try {
      const projectUrl = safeProjectUrl(projectId);
      if (projectUrl === undefined) return false;
      await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (!isProjectUrl(page.url(), projectId)) return false;
      const field = await firstVisible(page, CHATGPT_SELECTORS.projectInstructions);
      if (field === undefined) return false;
      await field.fill(instructions);
      const save = await firstVisible(page, CHATGPT_SELECTORS.projectSave);
      if (save === undefined) return false;
      await save.click();
      const expected = instructions.trim();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const actual = (await field.inputValue().catch(() => field.innerText().catch(() => ""))).trim();
        if (actual === expected) return true;
        if (Date.now() >= deadline) return false;
        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      }
    } catch {
      return false;
    }
  }

  async function inspectProjectPage(page: ProjectSurfacePage, projectId: string): Promise<ProjectInspection> {
    const projectUrl = safeProjectUrl(projectId);
    if (projectUrl === undefined) return { state: "unknown", reason: "surface-unrecognised" };
    try {
      await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch {
      return { state: "unknown", reason: "network" };
    }
    let snapshot: SurfaceSnapshot;
    try {
      snapshot = await readSnapshot(page);
    } catch {
      return { state: "unknown", reason: "network" };
    }
    if (!isProjectUrl(snapshot.url, projectId)) {
      return { state: "unknown", reason: "surface-unrecognised" };
    }
    const classification = classifySurface(snapshot);
    if (classification.state === "signed-out" || classification.state === "human-verification") {
      return { state: "unknown", reason: "needs-human" };
    }
    if (classification.state === "provider-error") return { state: "unknown", reason: "network" };
    const unavailable = await firstVisible(page, CHATGPT_SELECTORS.projectUnavailable);
    if (unavailable !== undefined) return { state: "gone" };
    if (!(await hasProjectControls(page))) {
      return { state: "unknown", reason: "surface-unrecognised" };
    }
    // Ambiguity never proves absence. A Project page we cannot read leaves the verdict `unknown`, and the
    // mapping layer keeps the recorded id instead of creating a second Project (INV-08).
    if (classification.state === "unknown") return { state: "unknown", reason: "surface-unrecognised" };
    const title = scrubPageText(snapshot.title.replace(/ - ChatGPT$/u, ""), 200);
    if (title.length === 0 || title.toLowerCase() === "chatgpt") {
      return { state: "unknown", reason: "surface-unrecognised" };
    }
    return { state: "present", title, projectUrl: CHATGPT_URLS.project(projectId) };
  }

  function pageScopes(page: ProjectSurfacePage): readonly ProjectSurfaceScope[] {
    const main: ProjectSurfaceScope = { locator: (selector: string) => page.locator(selector) };
    const scopes: ProjectSurfaceScope[] = [main];
    try {
      for (const frame of page.frames()) {
        try {
          if (isChatGptSurfaceUrl(frame.url())) scopes.push(frame);
        } catch {
          // A foreign or closing frame is not a trusted ChatGPT surface; skip it rather than using its DOM.
        }
      }
    } catch {
      // A closing page can throw while enumerating frames. The main document is still the only safe
      // scope to probe; callers will return an unrecognised surface if it cannot answer either.
    }
    return scopes;
  }
}

function projectSurfaceFailure(snapshot: SurfaceSnapshot): "needs-human" | "surface-unrecognised" | "provider-error" | undefined {
  const state = classifySurface(snapshot).state;
  if (state === "signed-out" || state === "human-verification") return "needs-human";
  if (state === "provider-error") return "provider-error";
  if (state === "unknown" && !isChatGptSurfaceUrl(snapshot.url)) return "surface-unrecognised";
  return undefined;
}

function isProjectUrl(url: string, projectId: string): boolean {
  return isChatGptSurfaceUrl(url) && parseProjectIdFromHref(url) === projectId;
}

function isConversationUrl(url: string, conversationId: string): boolean {
  return isChatGptSurfaceUrl(url) && parseConversationIdFromHref(url) === conversationId;
}

function safeProjectUrl(projectId: string): string | undefined {
  try {
    return CHATGPT_URLS.project(projectId);
  } catch {
    return undefined;
  }
}

function safeConversationUrl(conversationId: string): string | undefined {
  try {
    return CHATGPT_URLS.conversation(conversationId);
  } catch {
    return undefined;
  }
}

function safePageUrl(page: ProjectSurfacePage): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}
