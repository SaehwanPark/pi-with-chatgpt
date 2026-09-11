import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { AdviserProjectSurface } from "../browser/runtime-types.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import {
  ensureProjectForRepository,
  projectKeyFor,
  readProjectMappingFile,
  type EnsureProjectResult,
} from "./project-mapping.js";
import { buildProjectInstructions, projectTitleForRepository } from "./project-instructions.js";
import { fakeProjectSurface, tempStateLayout } from "../test/state-harness.js";
import { nodeStateStore } from "../ledger/state-store.js";

const REPOSITORY = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");
const INSTRUCTIONS = buildProjectInstructions({ repository: REPOSITORY });

function dependencies(
  layout: Awaited<ReturnType<typeof tempStateLayout>>["layout"],
  surface: AdviserProjectSurface,
  fileSystem?: typeof nodeStateStore,
) {
  return {
    layout,
    repository: REPOSITORY,
    surface,
    instructions: INSTRUCTIONS,
    ...(fileSystem === undefined ? {} : { fileSystem }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  };
}

function success(result: EnsureProjectResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.explanation);
  return result;
}

describe("repository to Project mapping (INV-08, INV-12, INV-15)", () => {
  it("maps the same repository to the same Project across branches, tasks, and sessions", async () => {
    const { layout } = await tempStateLayout("project-stable");
    const fake = fakeProjectSurface();

    const first = success(
      await ensureProjectForRepository(dependencies(layout, fake.surface)),
    ); // main / task-a / session-1
    const second = success(
      await ensureProjectForRepository(dependencies(layout, fake.surface)),
    ); // feature/login / task-b / session-2
    const third = success(
      await ensureProjectForRepository(dependencies(layout, fake.surface)),
    ); // release / task-c / session-3

    expect(new Set([first.mapping.projectId, second.mapping.projectId, third.mapping.projectId])).toEqual(
      new Set([first.mapping.projectId]),
    );
    expect(fake.calls.create).toHaveLength(1);
    expect(first.mapping.projectKey).toBe(projectKeyFor(REPOSITORY));
    expect((await readProjectMappingFile(layout)).file.projects[projectKeyFor(REPOSITORY)]).toMatchObject({
      projectId: first.mapping.projectId,
      repository: REPOSITORY,
    });
  });

  it("creates the Project exactly once when two Pi sessions race", async () => {
    const { layout } = await tempStateLayout("project-race");
    const fake = fakeProjectSurface();
    const results = await Promise.all([
      ensureProjectForRepository(dependencies(layout, fake.surface)),
      ensureProjectForRepository(dependencies(layout, fake.surface)),
    ]);
    const successful = results.map(success);

    expect(new Set(successful.map((result) => result.mapping.projectId))).toEqual(new Set(["project-1"]));
    expect(fake.calls.create).toHaveLength(1);
    expect(Object.keys((await readProjectMappingFile(layout)).file.projects)).toEqual([
      projectKeyFor(REPOSITORY),
    ]);
  });

  it("adopts a Project created concurrently outside this process", async () => {
    const { layout } = await tempStateLayout("project-adopt");
    const fake = fakeProjectSurface({ refuseCreation: "name-taken" });
    const external = {
      projectId: "external-project-42",
      title: projectTitleForRepository(REPOSITORY),
      projectUrl: "https://chatgpt.com/project/external-project-42",
    };
    let listCalls = 0;
    const surface: AdviserProjectSurface = {
      ...fake.surface,
      listProjects: () => {
        listCalls += 1;
        return Promise.resolve({ ok: true as const, projects: listCalls === 1 ? [] : [external] });
      },
    };

    const result = success(await ensureProjectForRepository(dependencies(layout, surface)));

    expect(result.outcome).toBe("adopted");
    expect(result.mapping.projectId).toBe(external.projectId);
    expect(result.mapping.projectTitle).toBe(external.title);
    expect(listCalls).toBe(2);
    expect(fake.calls.create).toHaveLength(1);
    expect((await readProjectMappingFile(layout)).file.projects[projectKeyFor(REPOSITORY)]?.projectId).toBe(
      external.projectId,
    );
  });

  it("keeps the Project id when the title is renamed remotely", async () => {
    const { layout } = await tempStateLayout("project-rename");
    const fake = fakeProjectSurface();
    const initial = success(await ensureProjectForRepository(dependencies(layout, fake.surface)));
    const renamedTitle = "pi-with-chatgpt: renamed externally";
    fake.projects.set(initial.mapping.projectId, renamedTitle);

    const result = success(await ensureProjectForRepository(dependencies(layout, fake.surface)));

    expect(result.outcome).toBe("renamed");
    expect(result.mapping.projectId).toBe(initial.mapping.projectId);
    expect(result.mapping.projectTitle).toBe(renamedTitle);
    expect(result.mapping.renameCount).toBe(1);
    expect(result.mapping.recreateCount).toBe(0);
  });

  it("recreates once when the Project was deleted and records the replacement", async () => {
    const { layout } = await tempStateLayout("project-recreate");
    const fake = fakeProjectSurface();
    const initial = success(await ensureProjectForRepository(dependencies(layout, fake.surface)));
    fake.projects.delete(initial.mapping.projectId);

    const recreated = success(await ensureProjectForRepository(dependencies(layout, fake.surface)));
    const reused = success(await ensureProjectForRepository(dependencies(layout, fake.surface)));

    expect(recreated.outcome).toBe("recreated");
    expect(recreated.mapping.projectId).not.toBe(initial.mapping.projectId);
    expect(recreated.mapping.recreateCount).toBe(1);
    expect(recreated.mapping.lastEvent).toBe("recreated");
    expect(reused.outcome).toBe("reused");
    expect(reused.mapping.projectId).toBe(recreated.mapping.projectId);
    expect(reused.mapping.recreateCount).toBe(1);
    expect(fake.calls.create).toHaveLength(2);
  });

  it("refuses to overwrite a corrupt mapping file", async () => {
    const { layout } = await tempStateLayout("project-corrupt");
    const fake = fakeProjectSurface();
    await mkdir(layout.stateRoot, { mode: 0o700, recursive: true });
    const corrupt = JSON.stringify({ version: 1, projects: { [projectKeyFor(REPOSITORY)]: { projectId: "orphan" } } });
    await writeFile(layout.projectMappingFile, corrupt, "utf8");

    const result = await ensureProjectForRepository(dependencies(layout, fake.surface));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected corrupt mapping refusal");
    expect(result.reason).toBe("state-corrupt");
    expect(result.explanation).toContain(layout.projectMappingFile);
    expect(fake.calls.list).toBe(0);
    expect(fake.calls.create).toHaveLength(0);
    expect(await readFile(layout.projectMappingFile, "utf8")).toBe(corrupt);
  });

  it("persists the mapping before reporting it as ready", async () => {
    const { layout } = await tempStateLayout("project-persist");
    const fake = fakeProjectSurface();
    const events: string[] = [];
    const fileSystem = {
      ...nodeStateStore,
      rename: async (from: string, to: string) => {
        await nodeStateStore.rename(from, to);
        if (to === layout.projectMappingFile) events.push("mapping-persisted");
      },
    };

    const result = success(await ensureProjectForRepository(dependencies(layout, fake.surface, fileSystem)));
    events.push("reported-ready");

    expect(events).toEqual(["mapping-persisted", "reported-ready"]);
    const stored = await readProjectMappingFile(layout, fileSystem);
    expect(stored.corrupt).toBe(false);
    expect(stored.file.projects[projectKeyFor(REPOSITORY)]).toEqual(result.mapping);
  });
});
