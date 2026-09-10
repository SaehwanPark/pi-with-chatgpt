import { describe, expect, it } from "vitest";

import { CHECKPOINT_SHA, fakeGit, type FakeGitOutcome } from "../test/fixtures.js";
import { MAX_REF_LENGTH, resolveCheckpointRef, validateRefShape } from "./ref-resolution.js";

const SHA = CHECKPOINT_SHA;

function resolver(outcome: FakeGitOutcome | string) {
  return fakeGit({ [`rev-parse --verify --quiet ${"main"}^{commit}`]: outcome });
}

describe("validateRefShape", () => {
  it.each([
    ["empty", "   ", "empty-ref"],
    ["flag-like", "--upload-pack=/bin/sh", "ref-looks-like-a-flag"],
    ["newline", "main\nquit", "ref-contains-control-characters"],
    ["backtick", "`id`", "ref-contains-control-characters"],
    ["escape", "main\u001b[2J", "ref-contains-control-characters"],
    ["unicode line separator", "main\u2028echo pwned", "ref-contains-control-characters"],
    ["delete", "main\u007f", "ref-contains-control-characters"],
    ["too long", "a".repeat(MAX_REF_LENGTH + 1), "ref-too-long"],
  ])("rejects a %s ref before git sees it", (_label, ref, reason) => {
    expect(validateRefShape(ref)?.reason).toBe(reason);
  });

  it.each(["HEAD", "main", "refs/pull/12/head", "v1.0.0", SHA])("accepts %s", (ref) => {
    expect(validateRefShape(ref)).toBeUndefined();
  });
});

describe("resolveCheckpointRef", () => {
  it("resolves HEAD to a full SHA and keeps the requested ref", async () => {
    const { executor } = fakeGit({ "rev-parse --verify --quiet HEAD^{commit}": ` ${SHA}\n` });

    const result = await resolveCheckpointRef(executor, "/repo", "HEAD");
    expect(result).toEqual({ ok: true, resolution: { requestedRef: "HEAD", resolvedCommit: SHA } });
  });

  it("resolves a PR ref, which is how a PR-only contribution is anchored", async () => {
    const { executor } = fakeGit({
      "rev-parse --verify --quiet refs/pull/12/head^{commit}": SHA,
    });

    const result = await resolveCheckpointRef(executor, "/repo", "refs/pull/12/head");
    expect(result.ok).toBe(true);
  });

  it("peels a tag through ^{commit} rather than storing the tag object", async () => {
    const { executor, invocations } = fakeGit({
      "rev-parse --verify --quiet v1.0.0^{commit}": SHA,
    });

    await resolveCheckpointRef(executor, "/repo", "v1.0.0");
    expect(invocations[0]).toEqual(["rev-parse", "--verify", "--quiet", "v1.0.0^{commit}"]);
  });

  it("refuses an unresolvable ref with a structured reason", async () => {
    const { executor } = fakeGit({
      "rev-parse --verify --quiet nope^{commit}": { code: 1, stdout: "", stderr: "fatal: bad revision" },
    });

    const result = await resolveCheckpointRef(executor, "/repo", "nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe("unresolvable-ref");
  });

  it("refuses a ref that resolves to a non-commit object", async () => {
    const { executor } = fakeGit({
      "rev-parse --verify --quiet blob-ish^{commit}": "not-a-sha",
    });

    const result = await resolveCheckpointRef(executor, "/repo", "blob-ish");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe("resolved-to-non-commit");
  });

  it("never spawns git for a rejected ref shape", async () => {
    const { executor, invocations } = resolver(SHA);

    await resolveCheckpointRef(executor, "/repo", "--upload-pack=/bin/sh");
    expect(invocations).toHaveLength(0);
  });
});
