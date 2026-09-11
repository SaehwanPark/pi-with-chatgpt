import { describe, expect, it } from "vitest";

import { CHATGPT_SELECTORS, CHATGPT_URLS } from "./chatgpt-dom.js";
import {
  createPlaywrightProjectSurface,
  type ProjectSurfaceElement,
  type ProjectSurfacePage,
  type ProjectSurfaceLocator,
} from "./playwright-project-surface.js";

const PROJECT_ID = "project-1";
const CONVERSATION_ID = "conversation-1";

interface FakeNode {
  readonly kind: "card" | "new-project" | "name" | "instructions" | "save" | "new-chat" | "composer" | "deleted";
  readonly text: string;
  readonly href?: string;
  visible: boolean;
  value: string;
}

interface FakeSurfacePage {
  readonly page: ProjectSurfacePage;
  readonly navigations: string[];
  readonly typed: string[];
  readonly projectInstructions: () => string;
  readonly setBlankProjects: (blank: boolean) => void;
  readonly setUnreadableProjectCard: (unreadable: boolean) => void;
  readonly setDeletedProject: (projectId: string) => void;
}

function fakeSurfacePage(): FakeSurfacePage {
  let currentUrl: string = CHATGPT_URLS.projects;
  let mode: "projects" | "create" | "project" | "conversation" | "deleted" = "projects";
  let blankProjects = false;
  let unreadableProjectCard = false;
  let deletedProjectId: string | undefined;
  let instructions = "";
  const navigations: string[] = [];
  const typed: string[] = [];

  const page: ProjectSurfacePage = {
    url: () => currentUrl,
    title: () => Promise.resolve(mode === "project" ? "Project title - ChatGPT" : "ChatGPT"),
    goto: (url) => {
      navigations.push(url);
      currentUrl = url;
      if (url === CHATGPT_URLS.projects) {
        mode = "projects";
      } else if (url === CHATGPT_URLS.project(PROJECT_ID)) {
        mode = "project";
      } else if (url === CHATGPT_URLS.project("project-new")) {
        mode = "project";
      } else if (deletedProjectId !== undefined && url === CHATGPT_URLS.project(deletedProjectId)) {
        mode = "deleted";
      } else if (url === CHATGPT_URLS.conversation(CONVERSATION_ID)) {
        mode = "conversation";
      }
      return Promise.resolve(undefined);
    },
    locator: (selector) => locatorFor(selector),
    frames: () => [],
  };

  function locatorFor(selector: string): ProjectSurfaceLocator {
    const nodes = nodesFor(selector);
    return {
      count: () => Promise.resolve(nodes.length),
      nth: (index) => elementFor(nodes[index]!),
      first: () => elementFor(nodes[0]!),
    };
  }

  function nodesFor(selector: string): FakeNode[] {
    if (mode === "projects") {
      if (selector === CHATGPT_SELECTORS.projectCard[0] && !blankProjects) {
        return [
          {
            kind: "card",
            text: "pi-with-chatgpt: saehwanpark/pi-with-chatgpt",
            href: unreadableProjectCard ? "https://chatgpt.com/p/not a project id" : CHATGPT_URLS.project(PROJECT_ID),
            visible: true,
            value: "",
          },
        ];
      }
      if (selector === CHATGPT_SELECTORS.newProject[0] && !blankProjects) {
        return [{ kind: "new-project", text: "New project", visible: true, value: "" }];
      }
    }
    if (mode === "create") {
      if (selector === CHATGPT_SELECTORS.projectNameInput[0]) {
        return [{ kind: "name", text: "", visible: true, value: "" }];
      }
      if (selector === CHATGPT_SELECTORS.projectInstructions[0]) {
        return [{ kind: "instructions", text: instructions, visible: true, value: instructions }];
      }
      if (selector === CHATGPT_SELECTORS.projectSave[0]) {
        return [{ kind: "save", text: "Create", visible: true, value: "" }];
      }
    }
    if (mode === "project") {
      if (selector === CHATGPT_SELECTORS.projectInstructions[0]) {
        return [{ kind: "instructions", text: instructions, visible: true, value: instructions }];
      }
      if (selector === CHATGPT_SELECTORS.projectSave[0]) {
        return [{ kind: "save", text: "Save", visible: true, value: "" }];
      }
      if (selector === CHATGPT_SELECTORS.projectNewChat[0]) {
        return [{ kind: "new-chat", text: "New chat", visible: true, value: "" }];
      }
    }
    if (mode === "conversation" && selector === CHATGPT_SELECTORS.composer[0]) {
      return [{ kind: "composer", text: "", visible: true, value: "" }];
    }
    if (mode === "deleted" && selector === CHATGPT_SELECTORS.projectUnavailable[0]) {
      return [{ kind: "deleted", text: "Project not found", visible: true, value: "" }];
    }
    return [];
  }

  function elementFor(target: FakeNode): ProjectSurfaceElement {
    return {
      isVisible: () => Promise.resolve(target.visible),
      innerText: () => Promise.resolve(target.text),
      inputValue: () => Promise.resolve(target.value),
      getAttribute: (name) => Promise.resolve(name === "href" ? (target.href ?? null) : null),
      click: () => {
        if (target.kind === "new-project") mode = "create";
        if (target.kind === "save" && mode === "create") {
          currentUrl = CHATGPT_URLS.project("project-new");
          mode = "project";
        }
        if (target.kind === "new-chat") {
          currentUrl = CHATGPT_URLS.conversation(CONVERSATION_ID);
          mode = "conversation";
        }
        return Promise.resolve();
      },
      fill: (value) => {
        target.value = value;
        if (target.kind === "instructions") instructions = value;
        typed.push(value);
        return Promise.resolve();
      },
    };
  }

  return {
    page,
    navigations,
    typed,
    projectInstructions: () => instructions,
    setBlankProjects: (blank) => {
      blankProjects = blank;
    },
    setUnreadableProjectCard: (unreadable) => {
      unreadableProjectCard = unreadable;
    },
    setDeletedProject: (projectId) => {
      deletedProjectId = projectId;
    },
  };
}

describe("Playwright Project/conversation surface", () => {
  it("lists a Project with a canonical URL instead of treating the page as a blank ChatGPT surface", async () => {
    const fake = fakeSurfacePage();
    const surface = createPlaywrightProjectSurface({ page: () => Promise.resolve(fake.page), timeoutMs: 20, pollIntervalMs: 1 });

    const result = await surface.listProjects();

    expect(result).toEqual({
      ok: true,
      projects: [
        {
          projectId: PROJECT_ID,
          title: "pi-with-chatgpt: saehwanpark/pi-with-chatgpt",
          projectUrl: CHATGPT_URLS.project(PROJECT_ID),
        },
      ],
    });
  });

  it("reports an unreadable Project list instead of using an empty list to create a duplicate", async () => {
    const fake = fakeSurfacePage();
    fake.setBlankProjects(true);
    const surface = createPlaywrightProjectSurface({ page: () => Promise.resolve(fake.page), timeoutMs: 5, pollIntervalMs: 1 });

    await expect(surface.listProjects()).resolves.toEqual({ ok: false, reason: "surface-unrecognised" });
  });

  it("does not treat a visible but unreadable Project card as an empty list", async () => {
    const fake = fakeSurfacePage();
    fake.setUnreadableProjectCard(true);
    const surface = createPlaywrightProjectSurface({ page: () => Promise.resolve(fake.page), timeoutMs: 20, pollIntervalMs: 1 });

    await expect(surface.listProjects()).resolves.toEqual({ ok: false, reason: "surface-unrecognised" });
  });

  it("creates a Project, applies the standing instructions, and returns its id and URL", async () => {
    const fake = fakeSurfacePage();
    const surface = createPlaywrightProjectSurface({ page: () => Promise.resolve(fake.page), timeoutMs: 20, pollIntervalMs: 1 });
    const instructions = "Pi decides; ChatGPT advises. Inspect GitHub at the requested SHA.";

    const result = await surface.createProject({ title: "new Project", instructions });

    expect(result).toEqual({
      ok: true,
      projectId: "project-new",
      title: "new Project",
      projectUrl: CHATGPT_URLS.project("project-new"),
      instructionsApplied: true,
    });
    expect(fake.projectInstructions()).toBe(instructions);
    expect(fake.typed).toContain(instructions);
  });

  it("starts and inspects a conversation through the same ChatGPT surface", async () => {
    const fake = fakeSurfacePage();
    const surface = createPlaywrightProjectSurface({ page: () => Promise.resolve(fake.page), timeoutMs: 20, pollIntervalMs: 1 });

    const started = await surface.startConversation(PROJECT_ID);
    const inspected = await surface.inspectConversation(CONVERSATION_ID);

    expect(started).toEqual({
      ok: true,
      conversationId: CONVERSATION_ID,
      conversationUrl: CHATGPT_URLS.conversation(CONVERSATION_ID),
    });
    expect(inspected).toEqual({
      state: "live",
      conversationUrl: CHATGPT_URLS.conversation(CONVERSATION_ID),
    });
  });

  it("requires positive deletion evidence before recreating a Project", async () => {
    const fake = fakeSurfacePage();
    fake.setDeletedProject("project-missing");
    const surface = createPlaywrightProjectSurface({ page: () => Promise.resolve(fake.page), timeoutMs: 20, pollIntervalMs: 1 });

    await expect(surface.inspectProject("project-missing")).resolves.toEqual({ state: "gone" });
  });
});
