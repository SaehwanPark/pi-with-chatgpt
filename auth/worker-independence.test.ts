import { describe, expect, it } from "vitest";

import { assessAdviserEligibility, describeWorkerAndAdviser, WORKER_INDEPENDENCE_RULE } from "./worker-independence.js";

describe("assessAdviserEligibility", () => {
  it("is eligible for a local worker as long as an OpenAI sign-in exists", () => {
    // This is the whole product case: Qwen does the work, ChatGPT advises.
    const eligibility = assessAdviserEligibility({
      workerProviderId: "ollama",
      workerModelId: "qwen3-coder",
      openAiSignInAvailable: true,
    });
    expect(eligibility).toEqual({ eligible: true, reason: "worker-independent", credentialProviderId: "openai-codex" });
  });

  it("does not become more eligible when the worker is itself an OpenAI model", () => {
    // Pinning the negative: a refactor that reads the worker provider would make these two differ.
    const local = assessAdviserEligibility({ workerProviderId: "ollama", workerModelId: "qwen3", openAiSignInAvailable: true });
    const openAi = assessAdviserEligibility({ workerProviderId: "openai-codex", workerModelId: "gpt-5", openAiSignInAvailable: true });
    expect(local).toEqual(openAi);
  });

  it("refuses when there is no OpenAI sign-in, whatever the worker is", () => {
    const eligibility = assessAdviserEligibility({
      workerProviderId: "openai",
      workerModelId: "gpt-5",
      openAiSignInAvailable: false,
    });
    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) return;
    expect(eligibility.reason).toBe("no-openai-sign-in");
  });
});

describe("describeWorkerAndAdviser", () => {
  it("names the worker and the adviser as separate facts", () => {
    const line = describeWorkerAndAdviser(
      { workerProviderId: "ollama", workerModelId: "qwen3-coder", openAiSignInAvailable: true },
      { accountLabel: "a***@example.com", planHint: "plus" },
    );
    expect(line).toBe("worker: ollama/qwen3-coder; adviser: a***@example.com (plus)");
  });

  it("says when there is no adviser rather than showing an empty account", () => {
    const line = describeWorkerAndAdviser({ workerProviderId: "ollama", workerModelId: "qwen3", openAiSignInAvailable: false });
    expect(line).toBe("worker: ollama/qwen3; adviser: no OpenAI sign-in");
  });

  it("states the rule it implements", () => {
    expect(WORKER_INDEPENDENCE_RULE).toMatch(/never consulted/u);
  });
});
