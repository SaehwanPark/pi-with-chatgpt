import { describe, expect, it, vi } from "vitest";

import { requireFullCommitSha } from "../protocol/sha.js";
import { canonicalRepositoryKey } from "../protocol/repo.js";
import type { ConsultationAnchor } from "../protocol/checkpoint.js";
import type { AdviserBrowserRuntime } from "./runtime-types.js";
import { createConsultationCapabilityGate } from "./consultation-capability.js";
import { createBrowserTransactionScheduler } from "./transaction.js";

const repository = canonicalRepositoryKey("acme", "repo");
const checkpointSha = requireFullCommitSha("0123456789abcdef0123456789abcdef01234567");

function anchor(overrides: Partial<ConsultationAnchor> = {}): ConsultationAnchor {
  return {
    repository,
    remoteUrl: "git@github.com:acme/repo.git",
    requestedRef: "HEAD",
    resolvedCommit: checkpointSha,
    remoteAvailability: { status: "available" },
    ...overrides,
  };
}

function runtime(overrides: Partial<Pick<AdviserBrowserRuntime, "probeSurface" | "discoverModels">> = {}) {
  return {
    probeSurface: vi.fn<AdviserBrowserRuntime["probeSurface"]>().mockResolvedValue({
      state: "conversation-ready",
      actionable: true,
    }),
    discoverModels: vi.fn<AdviserBrowserRuntime["discoverModels"]>().mockResolvedValue({
      ok: true,
      models: [{ modelId: "gpt-5.5", displayName: "GPT-5.5", available: true }],
    }),
    ...overrides,
  };
}

describe("consultation capability gate", () => {
  it("requires all four V1 capabilities before returning a dispatchable result", async () => {
    const browser = runtime();
    const connector = vi.fn().mockResolvedValue("verified" as const);
    const gate = createConsultationCapabilityGate({
      runtime: browser,
      githubConnectorProbe: connector,
    });

    const result = await gate.ensureConsultationCapability({
      anchor: anchor(),
      modelPreference: ["gpt-5.5"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.modelId).toBe("gpt-5.5");
    expect(result.checklist.results).toEqual([
      { item: "chatgpt-access", outcome: "verified" },
      { item: "adviser-model", outcome: "verified" },
      { item: "github-connector", outcome: "verified" },
      { item: "target-repository", outcome: "verified" },
    ]);
    expect(connector).toHaveBeenCalledWith({ repository, checkpointSha });
  });

  it("fails closed when no connector verifier is wired into production", async () => {
    const result = await createConsultationCapabilityGate({ runtime: runtime() }).ensureConsultationCapability({
      anchor: anchor(),
      modelPreference: ["gpt-5.5"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.evaluation.blocking).toEqual([
      { item: "github-connector", outcome: "unverified" },
    ]);
    expect(result.explanation).toContain("github-connector:unverified");
  });

  it("does not dispatch when connector verification is unavailable or the checkpoint is not remote", async () => {
    const connector = vi.fn().mockResolvedValue("unavailable" as const);
    const result = await createConsultationCapabilityGate({
      runtime: runtime(),
      githubConnectorProbe: connector,
    }).ensureConsultationCapability({
      anchor: anchor({ remoteAvailability: { status: "unknown", reason: "probe-inconclusive" } }),
      modelPreference: ["gpt-5.5"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.evaluation.blocking).toEqual([
      { item: "github-connector", outcome: "unavailable" },
      { item: "target-repository", outcome: "unavailable" },
    ]);
  });

  it("does not probe models as if ChatGPT were available when the surface is signed out", async () => {
    const browser = runtime({
      probeSurface: vi.fn<AdviserBrowserRuntime["probeSurface"]>().mockResolvedValue({
        state: "signed-out",
        actionable: false,
      }),
    });
    const result = await createConsultationCapabilityGate({
      runtime: browser,
      githubConnectorProbe: vi.fn().mockResolvedValue("verified" as const),
    }).ensureConsultationCapability({ anchor: anchor(), modelPreference: ["gpt-5.5"] });

    expect(result.ok).toBe(false);
    expect(browser.discoverModels).not.toHaveBeenCalled();
    if (result.ok) return;
    expect(result.evaluation.blocking.map((entry) => entry.item)).toEqual([
      "chatgpt-access",
      "adviser-model",
    ]);
  });

  it("re-probes every request so revoked access cannot survive a stale positive cache", async () => {
    const browser = runtime();
    const connector = vi.fn().mockResolvedValue("verified" as const);
    const gate = createConsultationCapabilityGate({
      runtime: browser,
      githubConnectorProbe: connector,
    });
    const request = { anchor: anchor(), modelPreference: ["gpt-5.5"] };

    expect((await gate.ensureConsultationCapability(request)).ok).toBe(true);
    expect((await gate.ensureConsultationCapability(request)).ok).toBe(true);
    expect(browser.probeSurface).toHaveBeenCalledTimes(2);
    expect(connector).toHaveBeenCalledTimes(2);

    gate.invalidate();
    expect((await gate.ensureConsultationCapability(request)).ok).toBe(true);
    expect(browser.probeSurface).toHaveBeenCalledTimes(3);
    expect(connector).toHaveBeenCalledTimes(3);
  });

  it("serializes probes with the shared browser transaction", async () => {
    const browser = runtime();
    const order: string[] = [];
    let release: (() => void) | undefined;
    const firstProbe = new Promise<void>((resolve) => {
      release = resolve;
    });
    browser.probeSurface = vi.fn().mockImplementation(async () => {
      order.push("probe-start");
      await firstProbe;
      order.push("probe-end");
      return { state: "conversation-ready", actionable: true };
    });
    const gate = createConsultationCapabilityGate({
      runtime: browser,
      githubConnectorProbe: vi.fn().mockResolvedValue("verified" as const),
      browserTransaction: createBrowserTransactionScheduler(),
    });
    const first = gate.ensureConsultationCapability({ anchor: anchor(), modelPreference: ["gpt-5.5"] });
    const second = gate.ensureConsultationCapability({ anchor: anchor({ repository: canonicalRepositoryKey("acme", "other") }), modelPreference: ["gpt-5.5"] });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["probe-start"]);
    release?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["probe-start", "probe-end", "probe-start", "probe-end"]);
  });
});
