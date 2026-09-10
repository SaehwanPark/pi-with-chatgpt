import { describe, expect, it } from "vitest";

import { contextChannels, isGitHubWebUrl, V1_CONTEXT_CHANNELS, type ContextChannel } from "./context-channel.js";
import { requireAdviserProvider, UnsupportedAdviserProviderError, V1_ADVISER_PROVIDERS } from "./provider.js";

describe("GitHub-only context contract (INV-02, INV-16)", () => {
  it("offers exactly one context channel: github", () => {
    // Widening this list is an architecture decision, not a feature; this assertion is the gate.
    expect(V1_CONTEXT_CHANNELS).toEqual<readonly ContextChannel[]>(["github"]);
    expect(contextChannels()).toHaveLength(1);
  });

  it("accepts only https GitHub URLs as adviser-followable references", () => {
    expect(isGitHubWebUrl("https://github.com/o/r/commit/abc")).toBe(true);
    expect(isGitHubWebUrl("http://github.com/o/r")).toBe(false);
    expect(isGitHubWebUrl("https://gitlab.com/o/r")).toBe(false);
    expect(isGitHubWebUrl("/home/user/repo/file.ts")).toBe(false);
    expect(isGitHubWebUrl("file:///home/user/repo/file.ts")).toBe(false);
  });
});

describe("single adviser provider (INV-16)", () => {
  it("supports exactly one V1 provider", () => {
    expect(V1_ADVISER_PROVIDERS).toEqual(["chatgpt"]);
    expect(requireAdviserProvider("chatgpt")).toBe("chatgpt");
  });

  it.each(["claude", "gemini", "local-llm", ""] as const)("rejects the provider %s", (provider) => {
    expect(() => requireAdviserProvider(provider)).toThrow(UnsupportedAdviserProviderError);
  });
});
