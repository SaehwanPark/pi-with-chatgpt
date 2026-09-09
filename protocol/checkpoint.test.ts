import { describe, expect, it } from "vitest";

import {
  checkDispatchReadiness,
  isConsultationId,
  isRemoteAvailable,
  type ConsultationAnchor,
} from "./checkpoint.js";
import { canonicalRepositoryKey } from "./repo.js";
import { requireFullCommitSha } from "./sha.js";

const SHA = requireFullCommitSha("0f2c8f4a1d6b4f1e9c2d8e6a5b4c3d2e1f0a9b8c");
const OTHER_SHA = requireFullCommitSha("1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d");
const REPO = canonicalRepositoryKey("SaehwanPark", "pi-with-chatgpt");

function anchor(overrides: Partial<ConsultationAnchor> = {}): ConsultationAnchor {
  return {
    repository: REPO,
    remoteUrl: "git@github.com:SaehwanPark/pi-with-chatgpt.git",
    requestedRef: "HEAD",
    resolvedCommit: SHA,
    remoteAvailability: { status: "available" },
    ...overrides,
  };
}

describe("consultation identity (INV-03, INV-04)", () => {
  it("keeps the requested ref separate from the resolved commit", () => {
    const identity = anchor();
    expect(identity.requestedRef).toBe("HEAD");
    expect(identity.resolvedCommit).toBe(SHA);
    // A readonly record cannot be retargeted in place; a new object is required.
    const retargeted: ConsultationAnchor = { ...identity, resolvedCommit: OTHER_SHA };
    expect(identity.resolvedCommit).toBe(SHA);
    expect(retargeted.resolvedCommit).toBe(OTHER_SHA);
  });

  it("refuses dispatch when the checkpoint is not reachable on the selected remote", () => {
    const notRemote = checkDispatchReadiness(
      anchor({ remoteAvailability: { status: "unavailable", reason: "commit-not-on-remote" } }),
    );
    expect(notRemote.ready).toBe(false);
    if (notRemote.ready) throw new Error("expected refusal");
    expect(notRemote.code).toBe("checkpoint-not-remote");
    expect(notRemote.explanation).toContain("not inspectable");
  });

  it("refuses dispatch when remote reachability is merely unknown", () => {
    const unknown = checkDispatchReadiness(
      anchor({ remoteAvailability: { status: "unknown", reason: "network-unreachable" } }),
    );
    expect(unknown.ready).toBe(false);
    expect(isRemoteAvailable({ status: "unknown", reason: "probe-timeout" })).toBe(false);
  });

  it("allows dispatch only for an available checkpoint", () => {
    expect(checkDispatchReadiness(anchor()).ready).toBe(true);
  });

  it.each(["adv-4f2a-1", "adv-9z7k-task-2"])("accepts consultation id %s", (value) => {
    expect(isConsultationId(value)).toBe(true);
  });

  it.each(["4f2a", "adv-", "adv-ABC", "session-1234"] as const)("rejects %s as a consultation id", (value) => {
    expect(isConsultationId(value)).toBe(false);
  });
});
