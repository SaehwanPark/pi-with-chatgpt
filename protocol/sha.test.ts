import { describe, expect, it } from "vitest";

import {
  classifyCommitRef,
  InvalidCommitAnchorError,
  isFullCommitSha,
  parseFullCommitSha,
  requireFullCommitSha,
} from "./sha.js";

const SHA = "0f2c8f4a1d6b4f1e9c2d8e6a5b4c3d2e1f0a9b8c";

describe("immutable commit anchor (INV-03)", () => {
  it("accepts a 40-character lowercase commit SHA", () => {
    expect(isFullCommitSha(SHA)).toBe(true);
    expect(parseFullCommitSha(SHA)).toBe(SHA);
    expect(requireFullCommitSha(SHA)).toBe(SHA);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(requireFullCommitSha(`  ${SHA}\n`)).toBe(SHA);
  });

  it.each([
    ["HEAD", "not-hex"],
    ["main", "not-hex"],
    ["v1.0.0", "not-hex"],
    ["0f2c8f4", "abbreviated"],
    ["0F2C8F4A1D6B4F1E9C2D8E6A5B4C3D2E1F0A9B8C", "non-canonical-case"],
    ["0".repeat(64), "sha256-not-supported"],
    ["", "empty"],
    ["   ", "empty"],
  ] as const)("rejects %s as %s", (value, reason) => {
    expect(classifyCommitRef(value)?.reason).toBe(reason);
    expect(parseFullCommitSha(value)).toBeUndefined();
    expect(() => requireFullCommitSha(value)).toThrow(InvalidCommitAnchorError);
  });

  it("reports the rejection reason on the error", () => {
    try {
      requireFullCommitSha("main");
      expect.unreachable("branch name must not anchor a consultation");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCommitAnchorError);
      expect((error as InvalidCommitAnchorError).rejection).toBe("not-hex");
    }
  });
});
