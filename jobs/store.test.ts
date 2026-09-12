import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { adviserStateLayout, repositoryStateLayout } from "../config/state-layout.js";
import { acquireStateLock, nodeStateStore, type StateStoreFileSystem } from "../ledger/state-store.js";
import type { ConsultationId } from "../protocol/checkpoint.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import { requireFullCommitSha } from "../protocol/sha.js";
import { deliveryKeyForSession, type CreateJobInput, type JobBinding } from "./record.js";
import { ConsultationJobStore, jobAddress, jobFilePath, type CompleteJobInput } from "./store.js";

const checkpoint = requireFullCommitSha("a".repeat(40));
const laterHead = requireFullCommitSha("b".repeat(40));
const repository = canonicalRepositoryKey("example", "repository");
const binding: JobBinding = { projectId: "project-one", conversationId: "conversation-one", headAtDispatch: checkpoint };
const response: CompleteJobInput = {
  text: "Review the state transition before adopting this recommendation.",
  headAtReceipt: laterHead,
  resultStatus: "complete",
  actionItems: [],
};

function input(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    anchor: {
      repository, remoteUrl: "https://github.com/example/repository.git", requestedRef: "HEAD",
      resolvedCommit: checkpoint, remoteAvailability: { status: "available" },
    },
    branch: "main", kind: "review", taskId: "task-one", deliveryKey: deliveryKeyForSession("pi-run-one"),
    ...overrides,
  };
}

async function fixture(fileSystem: StateStoreFileSystem = nodeStateStore) {
  const root = await mkdtemp(join(tmpdir(), "pwc-jobs-"));
  const layout = adviserStateLayout(root);
  return { root, layout, store: new ConsultationJobStore(layout, fileSystem) };
}

describe("durable consultation transactions (M5)", () => {
  it("creates a private queued record before a claim can authorize dispatch", async () => {
    const { store, layout } = await fixture();
    const queued = await store.create(input());
    expect(queued).toMatchObject({ state: "queued", revision: 1, mode: "async", dependency: "advisory" });
    const address = jobAddress(queued);
    const secondProcess = new ConsultationJobStore(layout);
    expect(await secondProcess.get(address)).toEqual(queued);
    for (const path of [layout.stateRoot, layout.jobsDir, layout.locksDir]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    const path = jobFilePath(layout, queued.consultationId);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("pi-run-one");
    const claim = await store.claim(address, binding);
    expect(claim.claimed).toBe(true);
    expect(await secondProcess.get(address)).toEqual(claim.record);
    expect(claim.record).toMatchObject({ state: "running", revision: 2, binding });
  });

  it("refuses duplicate creation without replacing an existing consultation", async () => {
    const { store, layout } = await fixture();
    const id = "adv-stable-test" as ConsultationId;
    const queued = await store.create(input({ consultationId: id }));
    const other = new ConsultationJobStore(layout);
    await expect(other.create(input({ consultationId: id, taskId: "another-task" }))).rejects.toMatchObject({ code: "job-exists" });
    expect(await store.get(jobAddress(queued))).toEqual(queued);
  });

  it("allows exactly one concurrent creator for a stable ID", async () => {
    const { store, layout } = await fixture();
    const request = input({ consultationId: "adv-same-request" as ConsultationId });
    const outcomes = await Promise.allSettled([store.create(request), new ConsultationJobStore(layout).create(request)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" ? failure.reason : undefined).toMatchObject({ code: "job-exists" });
  });

  it("claims a job once across stores and never replays it after restart", async () => {
    const { store, layout } = await fixture();
    const address = jobAddress(await store.create(input()));
    const second = new ConsultationJobStore(layout);
    const claims = await Promise.all([store.claim(address, binding), second.claim(address, binding)]);
    expect(claims.map((claim) => claim.claimed).sort()).toEqual([false, true]);
    expect(await new ConsultationJobStore(layout).claim(address, binding)).toMatchObject({
      claimed: false, record: { state: "running", revision: 2 },
    });
  });

  it("snapshots caller-owned anchor and binding before asynchronous storage work", async () => {
    const { store } = await fixture();
    const request = input();
    const creating = store.create(request);
    (request.anchor as { requestedRef: string }).requestedRef = "another-branch";
    const record = await creating;
    expect(record.anchor.requestedRef).toBe("HEAD");
    const mutableBinding = { ...binding };
    const claiming = store.claim(jobAddress(record), mutableBinding);
    mutableBinding.conversationId = "another-conversation";
    expect((await claiming).record.binding?.conversationId).toBe(binding.conversationId);
  });

  it("does not authorize dispatch when persisting a running claim fails", async () => {
    const fs: StateStoreFileSystem = {
      ...nodeStateStore,
      rename: async (from, to) => {
        if (JSON.parse(await readFile(from, "utf8")).record?.state === "running") throw new Error("interrupted claim");
        await nodeStateStore.rename(from, to);
      },
    };
    const { store } = await fixture(fs);
    const address = jobAddress(await store.create(input()));
    await expect(store.claim(address, binding)).rejects.toMatchObject({ code: "state-unreadable" });
    expect((await store.get(address))?.state).toBe("queued");
  });

  it("reports an owned job lock as busy without changing the job", async () => {
    const { store, layout } = await fixture();
    const record = await store.create(input());
    const address = jobAddress(record);
    const lock = await acquireStateLock({ path: join(layout.locksDir, `job-${record.consultationId}.lock`) });
    let time = Date.now();
    const contended = new ConsultationJobStore(layout, { ...nodeStateStore, now: () => time += 20_000 });
    try {
      await expect(contended.claim(address, binding)).rejects.toMatchObject({ code: "state-busy" });
      expect(await store.get(address)).toEqual(record);
    } finally {
      await lock.release();
    }
  });

  it("keeps independent tasks and their immutable anchors separate through receipt", async () => {
    const { store } = await fixture();
    const first = await store.create(input());
    const second = await store.create(input({ taskId: "task-two", deliveryKey: deliveryKeyForSession("pi-run-two") }));
    const addresses = [jobAddress(first), jobAddress(second)];
    await Promise.all(addresses.map((address, index) => store.claim(address, { ...binding, conversationId: `conversation-${index}` })));
    await Promise.all(addresses.map((address, index) => store.complete(address, { ...response, text: `Answer ${index}` })));
    for (const [index, address] of addresses.entries()) {
      const record = await store.get(address);
      expect(record?.anchor.resolvedCommit).toBe(checkpoint);
      expect(record?.anchor.requestedRef).toBe("HEAD");
      expect(record?.result?.headAtReceipt).toBe(laterHead);
      expect((await store.readPersistedResponse(address))?.text).toBe(`Answer ${index}`);
    }
  });

  it("retains detached-HEAD, PR, mode, and parsed-item metadata without retargeting the checkpoint", async () => {
    const { store } = await fixture();
    const pullRequest = { number: 42, headCommit: laterHead };
    const record = await store.create(input({
      branch: null, mode: "sync", dependency: "required", anchor: { ...input().anchor, pullRequest },
    }));
    const address = jobAddress(record);
    await store.claim(address, { ...binding, headAtDispatch: laterHead });
    const actionItems = [{ id: "A1", summary: "Check the task identity before delivery." }];
    const completed = await store.complete(address, { ...response, actionItems });
    expect(completed).toMatchObject({
      branch: null, mode: "sync", dependency: "required",
      anchor: { requestedRef: "HEAD", resolvedCommit: checkpoint, pullRequest },
      binding: { headAtDispatch: laterHead }, result: { actionItems },
    });
    expect((await store.readPersistedResponse(address))?.result.actionItems).toEqual(actionItems);
  });

  it.each(["repository", "taskId", "deliveryKey"] as const)("refuses cross-delivery through mismatched %s", async (field) => {
    const { store } = await fixture();
    const address = jobAddress(await store.create(input()));
    const wrong = { ...address, [field]: field === "repository" ? canonicalRepositoryKey("other", "repo") : "wrong-origin" };
    await expect(store.get(wrong)).rejects.toMatchObject({ code: "job-scope-mismatch" });
    await expect(store.claim(wrong, binding)).rejects.toMatchObject({ code: "job-scope-mismatch" });
    await expect(store.readPersistedResponse(wrong)).rejects.toMatchObject({ code: "job-scope-mismatch" });
    expect((await store.get(address))?.state).toBe("queued");
  });

  it("resolves an ID to its real immutable address and enforces lookup scope", async () => {
    const { store } = await fixture();
    const queued = await store.create(input());
    expect(await store.getByConsultationId(queued.consultationId)).toEqual(queued);
    expect(await store.getByConsultationId(queued.consultationId, {
      repository,
      taskId: queued.taskId,
      deliveryKey: queued.deliveryKey,
    })).toEqual(queued);
    await expect(store.getByConsultationId(queued.consultationId, { taskId: "other-task" }))
      .rejects.toMatchObject({ code: "job-scope-mismatch" });
    expect(await store.getByConsultationId("adv-missing-id" as ConsultationId)).toBeUndefined();
  });

  it("reconciles running jobs as interrupted failures without replaying them", async () => {
    const { store, layout } = await fixture();
    const running = await store.create(input());
    await store.claim(jobAddress(running), binding);

    const reconciled = await new ConsultationJobStore(layout).reconcileRunningJobs();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ state: "failed", failure: "interrupted", revision: 3 });
    expect(await store.list({ states: ["running"] })).toHaveLength(0);
    expect(await store.get(jobAddress(running))).toMatchObject({ state: "failed", failure: "interrupted" });
    expect(await new ConsultationJobStore(layout).reconcileRunningJobs()).toEqual([]);
  });

  it("stores the full response before exposing completion and retains it after restart", async () => {
    let responseWasWritten = false;
    const fs: StateStoreFileSystem = {
      ...nodeStateStore,
      rename: async (from, to) => {
        const data = JSON.parse(await readFile(from, "utf8"));
        if (data.record?.state === "completed") expect(responseWasWritten).toBe(true);
        await nodeStateStore.rename(from, to);
        if (data.text !== undefined) responseWasWritten = true;
      },
    };
    const { store, layout } = await fixture(fs);
    const address = jobAddress(await store.create(input()));
    await store.claim(address, binding);
    const completed = await store.complete(address, response);
    const restarted = new ConsultationJobStore(layout);
    expect(await restarted.get(address)).toEqual(completed);
    expect(await restarted.readPersistedResponse(address)).toMatchObject({ text: response.text, resolvedCommit: checkpoint });
    const responseDir = repositoryStateLayout(layout, repository).responsesDir;
    expect((await stat(responseDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(responseDir, `${address.consultationId}.json`))).mode & 0o777).toBe(0o600);
  });

  it("preserves a response after an interrupted terminal write and refuses a replacement answer", async () => {
    let interrupt = true;
    const fs: StateStoreFileSystem = {
      ...nodeStateStore,
      rename: async (from, to) => {
        if (interrupt && JSON.parse(await readFile(from, "utf8")).record?.state === "completed") {
          throw new Error("machine-specific path or private material must not escape");
        }
        await nodeStateStore.rename(from, to);
      },
    };
    const { store, layout } = await fixture(fs);
    const address = jobAddress(await store.create(input()));
    await store.claim(address, binding);
    await expect(store.complete(address, response)).rejects.toMatchObject({ code: "state-unreadable" });
    const restarted = new ConsultationJobStore(layout);
    expect((await restarted.get(address))?.state).toBe("running");
    expect((await restarted.readPersistedResponse(address))?.text).toBe(response.text);
    expect(await restarted.claim(address, binding)).toMatchObject({ claimed: false });
    interrupt = false;
    await expect(store.complete(address, { ...response, text: "A second answer" })).rejects.toMatchObject({ code: "state-corrupt" });
    expect((await store.complete(address, response)).state).toBe("completed");
    expect(await readdir(layout.jobsDir)).toEqual([`${address.consultationId}.json`]);
  });

  it("leaves a job running and stores no result when response persistence fails", async () => {
    const fs: StateStoreFileSystem = {
      ...nodeStateStore,
      rename: async (from, to) => {
        if (JSON.parse(await readFile(from, "utf8")).text !== undefined) throw new Error("response write interrupted");
        await nodeStateStore.rename(from, to);
      },
    };
    const { store } = await fixture(fs);
    const address = jobAddress(await store.create(input()));
    await store.claim(address, binding);
    await expect(store.complete(address, response)).rejects.toMatchObject({ code: "state-unreadable" });
    expect((await store.get(address))?.state).toBe("running");
    expect(await store.readPersistedResponse(address)).toBeUndefined();
  });

  it("makes duplicate completion and cancellation return the existing terminal winner", async () => {
    const { store } = await fixture();
    const address = jobAddress(await store.create(input()));
    await store.claim(address, binding);
    const completed = await store.complete(address, response);
    expect(await store.complete(address, { ...response, text: "late answer" })).toEqual(completed);
    expect(await store.cancel(address)).toEqual(completed);
    expect((await store.readPersistedResponse(address))?.text).toBe(response.text);
  });

  it("does not persist a late browser result after cancellation", async () => {
    const { store } = await fixture();
    const address = jobAddress(await store.create(input()));
    await store.claim(address, binding);
    const cancelled = await store.cancel(address);
    expect(cancelled.state).toBe("cancelled");
    expect(await store.complete(address, response)).toEqual(cancelled);
    expect(await store.readPersistedResponse(address)).toBeUndefined();
  });

  it("serializes cancel/complete across stores with one persisted terminal winner", async () => {
    const { store, layout } = await fixture();
    const address = jobAddress(await store.create(input()));
    await store.claim(address, binding);
    const results = await Promise.all([store.complete(address, response), new ConsultationJobStore(layout).cancel(address)]);
    expect(results[0]).toEqual(results[1]);
    expect(await store.get(address)).toEqual(results[0]);
    expect(["completed", "cancelled"]).toContain(results[0]?.state);
  });

  it("refuses completion before dispatch and permits cancellation of a queued job", async () => {
    const { store } = await fixture();
    const address = jobAddress(await store.create(input()));
    await expect(store.complete(address, response)).rejects.toMatchObject({ code: "job-transition-invalid" });
    expect((await store.cancel(address)).state).toBe("cancelled");
    expect(await store.claim(address, binding)).toMatchObject({ claimed: false });
  });

  it.each(["advisory", "required"] as const)("preserves %s dependency with a closed failure reason", async (dependency) => {
    const { store } = await fixture();
    const address = jobAddress(await store.create(input({ dependency })));
    const failed = await store.fail(address, "auth_expired");
    expect(failed).toMatchObject({ state: "failed", failure: "auth_expired", dependency });
    expect(await store.cancel(address)).toEqual(failed);
    expect(await store.claim(address, binding)).toMatchObject({ claimed: false });
  });

  it("reports missing, corrupted, and mismatched job files without replacing them", async () => {
    const { store, layout } = await fixture();
    const queued = await store.create(input());
    const address = jobAddress(queued);
    expect(await store.get({ ...address, consultationId: "adv-missing-job" as ConsultationId })).toBeUndefined();
    const path = jobFilePath(layout, address.consultationId);
    await writeFile(path, "{broken json", "utf8");
    await expect(store.get(address)).rejects.toMatchObject({ code: "state-corrupt" });
    await expect(store.create(input({ consultationId: address.consultationId }))).rejects.toMatchObject({ code: "state-corrupt" });
    await writeFile(path, JSON.stringify({ version: 1, record: { ...queued, consultationId: "adv-wrong-file" } }), "utf8");
    await expect(store.get(address)).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("refuses response corruption, foreign identity, and missing completed artifacts", async () => {
    const { store, layout } = await fixture();
    const address = jobAddress(await store.create(input()));
    await store.claim(address, binding);
    await store.complete(address, response);
    const path = join(repositoryStateLayout(layout, repository).responsesDir, `${address.consultationId}.json`);
    const original = JSON.parse(await readFile(path, "utf8"));
    for (const changed of [{ ...original, text: "tampered text" }, { ...original, taskId: "foreign-task" }, { ...original, extra: "field" }]) {
      await writeFile(path, JSON.stringify(changed), "utf8");
      await expect(store.readPersistedResponse(address)).rejects.toMatchObject({ code: "state-corrupt" });
    }
    const missingResponseFs = { ...nodeStateStore, readFile: (target: string) => target === path ? Promise.resolve(undefined) : nodeStateStore.readFile(target) };
    await expect(new ConsultationJobStore(layout, missingResponseFs).readPersistedResponse(address)).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("refuses symlink files and managed directories", async () => {
    const { store, root, layout } = await fixture();
    const queued = await store.create(input());
    const target = join(root, "foreign-job.json");
    await writeFile(target, JSON.stringify({ version: 1, record: queued }), "utf8");
    const id = "adv-symlink-file" as ConsultationId;
    await symlink(target, jobFilePath(layout, id));
    await expect(store.get({ ...jobAddress(queued), consultationId: id })).rejects.toMatchObject({ code: "state-corrupt" });
    const other = await fixture();
    const outside = join(other.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await mkdir(other.layout.stateRoot, { mode: 0o700 });
    await symlink(outside, other.layout.jobsDir);
    await expect(other.store.create(input())).rejects.toMatchObject({ code: "state-corrupt" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses shared state directories without changing their permissions", async () => {
    const { store, layout } = await fixture();
    await mkdir(layout.stateRoot, { mode: 0o700 });
    await chmod(layout.stateRoot, 0o755);
    await expect(store.create(input())).rejects.toMatchObject({ code: "state-unreadable" });
    expect((await stat(layout.stateRoot)).mode & 0o777).toBe(0o755);
  });

  it("rejects secret-shaped response text before any result is written", async () => {
    const { store } = await fixture();
    const address = jobAddress(await store.create(input()));
    await store.claim(address, binding);
    const secret = `sk-${"x".repeat(32)}`;
    await expect(store.complete(address, { ...response, text: secret })).rejects.not.toThrow(secret);
    expect((await store.get(address))?.state).toBe("running");
    expect(await store.readPersistedResponse(address)).toBeUndefined();
  });

  it("does not expose injected filesystem exception text", async () => {
    const fs = { ...nodeStateStore, readFile: () => Promise.reject(new Error("Bearer secret-material-that-must-not-escape")) };
    const { store } = await fixture(fs);
    await expect(store.create(input())).rejects.toThrow("Consultation storage: state-unreadable.");
  });
});
