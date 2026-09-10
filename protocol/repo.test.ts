import { describe, expect, it } from "vitest";

import { canonicalRepositoryKey, parseGitHubRemote, supportedGitHubHosts } from "./repo.js";

const SHA = "0f2c8f4a1d6b4f1e9c2d8e6a5b4c3d2e1f0a9b8c";

describe("GitHub repository identity (INV-02, INV-08)", () => {
  it.each([
    "git@github.com:SaehwanPark/pi-with-chatgpt.git",
    "ssh://git@github.com/SaehwanPark/pi-with-chatgpt.git",
    "https://github.com/SaehwanPark/pi-with-chatgpt.git",
    "https://github.com/SaehwanPark/pi-with-chatgpt",
    "https://github.com/SaehwanPark/pi-with-chatgpt/",
  ])("canonicalises %s to the same repository key", (remote) => {
    const parsed = parseGitHubRemote(remote);
    expect(parsed.ok).toBe(true);
    expect(parsed.key).toBe("saehwanpark/pi-with-chatgpt");
  });

  it("keeps owner and repository case-insensitive so one repo maps to one key", () => {
    expect(canonicalRepositoryKey("SaehwanPark", "Pi-With-ChatGPT.git")).toBe("saehwanpark/pi-with-chatgpt");
  });

  it.each([
    "git@gitlab.com:owner/repo.git",
    "https://git.example.com/owner/repo.git",
    "https://ghe.internal/owner/repo.git",
  ])("rejects the non-GitHub remote %s (V1 is GitHub-only)", (remote) => {
    expect(parseGitHubRemote(remote)).toEqual({ ok: false, rejection: "unsupported-host" });
  });

  it("refuses a remote that embeds credentials instead of canonicalising it (INV-12)", () => {
    // Such a URL is a credential container: dropping the secret silently would put it in a key,
    // a log line, or model context on the way to being discarded.
    for (const url of [
      "https://user:ghp_secretmaterialhere@github.com/owner/repo.git",
      "https://oauth2@github.com/owner/repo.git",
      "ssh://user:secret@github.com/owner/repo.git",
    ]) {
      const result = parseGitHubRemote(url);
      expect(result.ok, url).toBe(false);
      expect(result.rejection, url).toBe("credentials-in-url");
      expect(result.key, url).toBeUndefined();
    }
    // The ordinary SSH spelling has no scheme and is not an embedded credential.
    expect(parseGitHubRemote("git@github.com:owner/repo.git").ok).toBe(true);
  });

  it("rejects remotes that are not parseable as a repository", () => {
    expect(parseGitHubRemote("not a remote").rejection).toBe("not-a-github-remote");
    expect(parseGitHubRemote("git@github.com:owneronly.git").rejection).toBe("malformed-path");
    expect(parseGitHubRemote("https://github.com").rejection).toBe("not-a-github-remote");
  });

  it("supports exactly the documented GitHub hosts", () => {
    expect(supportedGitHubHosts()).toEqual(["github.com", "www.github.com"]);
  });

  it("treats a repository key as independent of the anchor commit", () => {
    expect(SHA).toHaveLength(40);
    expect(parseGitHubRemote("git@github.com:o/r.git").key).toBe("o/r");
  });
});
