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
  ProjectSummary,
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

export interface ProjectSurfacePage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options: { readonly waitUntil: string; readonly timeout: number }): Promise<unknown>;
  locator(selector: string): ProjectSurfaceLocator;
  frames(): readonly { locator(selector: string): ProjectSurfaceLocator }[];
}

export interface PlaywrightProjectSurfaceOptions {
  /** The runtime's single tracked tab; this module never opens a second one. */
  readonly page: () => Promise<ProjectSurfacePage>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Cards scraped before the list settles are a partial truth, so the list is bounded and re-read once. */
const MAX_PROJECT_CARDS = 60;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_MS = 250;

export function createPlaywrightProjectSurface(
  options: PlaywrightProjectSurfaceOptions,
): AdviserProjectSurface {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function firstVisible(page: ProjectSurfacePage, selectors: readonly string[]): Promise<ProjectSurfaceElement | undefined> {
    const frames = [{ locator: (selector: string) => page.locator(selector) }, ...page.frames()];
    for (const frame of frames) {
      for (const selector of selectors) {
        const locator = frame.locator(selector);
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 12); index += 1) {
          const element = locator.nth(index);
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

  async function scrapeProjectCards(page: ProjectSurfacePage): Promise<readonly ProjectEntry[] | undefined> {
    const cards: { href: string | undefined; label: string | undefined }[] = [];
    let found = false;
    for (const frame of [{ locator: (selector: string) => page.locator(selector) }, ...page.frames()]) {
      for (const selector of CHATGPT_SELECTORS.projectCard) {
        const locator = frame.locator(selector);
        const count = await locator.count().catch(() => 0);
        if (count === 0) continue;
        found = true;
        for (let index = 0; index < Math.min(count, MAX_PROJECT_CARDS); index += 1) {
          const card = locator.nth(index);
          const href = await card.getAttribute("href").catch(() => null);
          const label = scrubPageText(await card.innerText().catch(() => ""), 200);
          cards.push({ href: href ?? undefined, label });
        }
      }
    }
    if (!found) return undefined;
    return parseProjectEntries(cards);
  }

  return {
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
      if (failure !== undefined && !(await hasProjectControls(page))) return { ok: false, reason: failure };
      const entries = await scrapeProjectCards(page);
      if (entries === undefined) {
        // An empty, recognised Projects page still needs a create control. Without one, absence of cards
        // is an unreadable list, not proof that the account has no Projects.
        const create = await firstVisible(page, CHATGPT_SELECTORS.newProject);
        if (create === undefined) return { ok: false, reason: "surface-unrecognised" };
        return { ok: true, projects: [] };
      }
      return {
        ok: true,
        projects: entries.map((entry) => ({
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
      const uncertain = classification.state === "unknown" || classification.state === "provider-error";
      const entries = uncertain ? undefined : await scrapeProjectCards(page);
      // A card that names the id is direct evidence, so a Projects list that does not show it is checked
      // against the Project page itself before it is called deleted.
      if (entries !== undefined && entries.some((entry) => entry.projectId === projectId)) {
        const entry = entries.find((candidate) => candidate.projectId === projectId) as ProjectEntry;
        return { state: "present", title: entry.title, projectUrl: CHATGPT_URLS.project(projectId) };
      }
      const verdict = classifyProjectPresence(entries, projectId, {
        signedOut: classification.state === "signed-out",
        loaded: entries !== undefined && classification.state !== "provider-error",
        needsHuman: classification.state === "human-verification",
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
      const entries = await scrapeProjectCards(page);
      const adopted = entries === undefined ? undefined : findProjectByTitle(entries, input.title);
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
      const snapshot = await gotoRecognised(page, CHATGPT_URLS.project(projectId));
      if (snapshot === undefined) return { ok: false, reason: "provider-error" };
      const classification = classifySurface(snapshot);
      if (classification.state === "signed-out" || classification.state === "human-verification") {
        return { ok: false, reason: "needs-human" };
      }
      if (classification.state === "provider-error") return { ok: false, reason: "provider-error" };
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
        const conversationId = parseConversationIdFromHref(page.url()) ?? linkedConversation;
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
      const snapshot = await gotoRecognised(page, CHATGPT_URLS.conversation(conversationId));
      if (snapshot === undefined) return { state: "unknown", reason: "network" };
      const deleted = await firstVisible(page, CHATGPT_SELECTORS.deletedConversation);
      const result = classifyConversationPresence({
        surface: classifySurface(snapshot).state,
        showsDeletedNotice: deleted !== undefined,
      });
      return result.state === "live"
        ? { ...result, conversationUrl: CHATGPT_URLS.conversation(conversationId) }
        : result;
    },
  };

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
      await page.goto(CHATGPT_URLS.project(projectId), { waitUntil: "domcontentloaded", timeout: timeoutMs });
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
    try {
      await page.goto(CHATGPT_URLS.project(projectId), { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch {
      return { state: "unknown", reason: "network" };
    }
    const snapshot = await readSnapshot(page);
    const classification = classifySurface(snapshot);
    if (classification.state === "signed-out" || classification.state === "human-verification") {
      return { state: "unknown", reason: "needs-human" };
    }
    if (classification.state === "provider-error") return { state: "unknown", reason: "network" };
    const unavailable = await firstVisible(page, CHATGPT_SELECTORS.projectUnavailable);
    if (unavailable !== undefined) return { state: "gone" };
    if (!isProjectUrl(page.url(), projectId) || !(await hasProjectControls(page))) {
      return { state: "unknown", reason: "surface-unrecognised" };
    }
    // Ambiguity never proves absence. A Project page we cannot read leaves the verdict `unknown`, and the
    // mapping layer keeps the recorded id instead of creating a second Project (INV-08).
    if (classification.state === "unknown") return { state: "unknown", reason: "surface-unrecognised" };
    const title = scrubPageText((await page.title().catch(() => "")).replace(/ - ChatGPT$/u, ""), 200);
    if (title.length === 0 || title.toLowerCase() === "chatgpt") {
      return { state: "unknown", reason: "surface-unrecognised" };
    }
    return { state: "present", title, projectUrl: CHATGPT_URLS.project(projectId) };
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
  try {
    return new URL(url).toString() === CHATGPT_URLS.project(projectId);
  } catch {
    return false;
  }
}
