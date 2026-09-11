/**
 * Shared helpers for the M4+ state tests: a real temporary state root and a scriptable Project surface.
 *
 * The state root is a real directory rather than an in-memory fake on purpose. The guarantees under test —
 * owner-only modes, atomic replacement, a lock that two competing callers cannot both hold — are properties
 * of the filesystem, and a fake would test only our belief about it (`auth/status.test.ts` set this
 * precedent for the profile tree).
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adviserStateLayout, type AdviserStateLayout } from "../config/state-layout.js";
import type {
  AdviserProjectSurface,
  ConversationInspection,
  ConversationStartResult,
  ProjectCreationResult,
  ProjectInspection,
  ProjectListResult,
  ProjectSummary,
} from "../browser/runtime-types.js";

export async function tempStateLayout(prefix: string): Promise<{ readonly layout: AdviserStateLayout; readonly dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `pwc-${prefix}-`));
  return { layout: adviserStateLayout(dir), dir };
}

export interface FakeSurfaceOptions {
  /** Projects that already exist when the test starts. */
  readonly projects?: readonly { readonly projectId: string; readonly title: string }[];
  /** Conversation ids that exist. Anything else reports `gone`. */
  readonly conversations?: readonly string[];
  /** Force the inspection answers, one per call, then fall back to the map. */
  readonly projectInspections?: readonly ProjectInspection[];
  readonly conversationInspections?: readonly ConversationInspection[];
  /** Refuse creation with a fixed reason instead of creating. */
  readonly refuseCreation?: "name-taken" | "needs-human" | "surface-unrecognised" | "provider-error" | "browser-lost";
  /** What `listProjects` answers, overriding the live map. */
  readonly listedProjects?: readonly ProjectSummary[];
}

export interface FakeSurface {
  readonly surface: AdviserProjectSurface;
  readonly calls: {
    list: number;
    create: { readonly title: string; readonly instructions: string }[];
    start: string[];
    inspectProject: string[];
    inspectConversation: string[];
    applyInstructions: { readonly projectId: string; readonly instructions: string }[];
  };
  /** Mutated by creation, so a test can assert what the surface actually ended up holding. */
  readonly projects: Map<string, string>;
  readonly conversations: Set<string>;
}

export function fakeProjectSurface(options: FakeSurfaceOptions = {}): FakeSurface {
  const projects = new Map<string, string>();
  for (const project of options.projects ?? []) projects.set(project.projectId, project.title);
  const conversations = new Set<string>(options.conversations ?? []);
  const calls = {
    list: 0,
    create: [] as { title: string; instructions: string }[],
    start: [] as string[],
    inspectProject: [] as string[],
    inspectConversation: [] as string[],
    applyInstructions: [] as { projectId: string; instructions: string }[],
  };
  const projectInspections = [...(options.projectInspections ?? [])];
  const conversationInspections = [...(options.conversationInspections ?? [])];
  let created = 0;

  const surface: AdviserProjectSurface = {
    listProjects(): Promise<ProjectListResult> {
      calls.list += 1;
      if (options.listedProjects !== undefined) return Promise.resolve({ ok: true, projects: options.listedProjects });
      return Promise.resolve({
        ok: true,
        projects: [...projects.entries()].map(([projectId, title]) => ({
          projectId,
          title,
          projectUrl: `https://chatgpt.com/p/${projectId}`,
        })),
      });
    },
    inspectProject(projectId): Promise<ProjectInspection> {
      calls.inspectProject.push(projectId);
      const scripted = projectInspections.shift();
      if (scripted !== undefined) return Promise.resolve(scripted);
      const title = projects.get(projectId);
      return Promise.resolve(
        title === undefined
          ? { state: "gone" }
          : { state: "present", title, projectUrl: `https://chatgpt.com/p/${projectId}` },
      );
    },
    createProject(input): Promise<ProjectCreationResult> {
      calls.create.push(input);
      if (options.refuseCreation !== undefined) return Promise.resolve({ ok: false, reason: options.refuseCreation });
      // A real surface refuses a duplicate name, which is what forces the caller to adopt (INV-08).
      const clash = [...projects.entries()].find(([, title]) => title.trim() === input.title.trim());
      if (clash !== undefined) return Promise.resolve({ ok: false, reason: "name-taken" });
      created += 1;
      const projectId = `project-${created}`;
      projects.set(projectId, input.title);
      return Promise.resolve({
        ok: true,
        projectId,
        title: input.title,
        projectUrl: `https://chatgpt.com/p/${projectId}`,
        instructionsApplied: true,
      });
    },
    applyInstructions(projectId, instructions) {
      calls.applyInstructions.push({ projectId, instructions });
      return Promise.resolve(projects.has(projectId));
    },
    startConversation(projectId): Promise<ConversationStartResult> {
      calls.start.push(projectId);
      if (!projects.has(projectId)) return Promise.resolve({ ok: false, reason: "surface-unrecognised" });
      const conversationId = `conversation-${conversations.size + 1}`;
      conversations.add(conversationId);
      return Promise.resolve({
        ok: true,
        conversationId,
        conversationUrl: `https://chatgpt.com/g/${conversationId}`,
      });
    },
    inspectConversation(conversationId): Promise<ConversationInspection> {
      calls.inspectConversation.push(conversationId);
      const scripted = conversationInspections.shift();
      if (scripted !== undefined) return Promise.resolve(scripted);
      return Promise.resolve(
        conversations.has(conversationId)
          ? { state: "live", conversationUrl: `https://chatgpt.com/g/${conversationId}` }
          : { state: "gone" },
      );
    },
  };

  return { surface, calls, projects, conversations };
}
