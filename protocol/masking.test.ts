/**
 * Display masking (INV-12).
 *
 * The interesting assertions are the negative ones: a masked value must not be reassemblable, and a
 * value too short to mask partially must collapse to nothing rather than publish most of itself.
 */

import { describe, expect, it } from "vitest";

import { containsSensitiveData, maskEmail, maskOpaqueId, redactSensitiveText } from "./masking.js";

describe("maskEmail", () => {
  it("keeps enough of an address for a human to recognise the account", () => {
    expect(maskEmail("ada.lovelace@analytical.engine.co.uk")).toBe("a***@analytical.engine.co.uk");
  });

  it("does not leave the local part recoverable", () => {
    const masked = maskEmail("ada.lovelace@example.com");
    expect(masked).not.toContain("lovelace");
    expect(masked).not.toContain("ada.");
  });

  it("masks the repeated-character and single-character local parts alike", () => {
    // The first character is kept, so a one-letter local part is fully visible; the domain is where
    // the recognition value is, and this records the trade rather than pretending it away.
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
    expect(maskEmail("aaaaaa@example.com")).toBe("a***@example.com");
  });

  it.each(["", "@", "no-at-sign", "@example.com"])("returns nothing for the malformed address %s", (value) => {
    expect(maskEmail(value)).toBe("***");
  });

  it("splits on the last @ so a quoted local part cannot forge a domain", () => {
    // "a@evil@example.com" is not a valid address, but a mask that split on the first @ would report
    // the attacker-controlled fragment as the domain.
    expect(maskEmail("a@evil@example.com")).toBe("a***@example.com");
  });
});

describe("maskOpaqueId", () => {
  it("keeps a recognisable prefix of a long identifier", () => {
    expect(maskOpaqueId("0192abcdef8866...")).toBe("0192ab…");
  });

  it("hides short identifiers entirely", () => {
    // A prefix mask on a 6-character id would publish the whole value; below the recognisable
    // threshold the honest answer is "nothing".
    expect(maskOpaqueId("123456")).toBe("***");
    expect(maskOpaqueId("")).toBe("***");
  });

  it("never reveals the tail of an identifier", () => {
    const id = "0192abcdef0000111122223333";
    expect(maskOpaqueId(id)).not.toContain(id.slice(-6));
  });
});

describe("redactSensitiveText", () => {
  it("redacts credential-shaped prose without discarding the rest of the answer", () => {
    const result = redactSensitiveText("The test fixture uses ghp_1234567890123456; keep the retry logic.");

    expect(result.redacted).toBe(true);
    expect(result.text).toContain("keep the retry logic");
    expect(result.text).not.toContain("ghp_1234567890123456");
    expect(containsSensitiveData(result.text)).toBe(false);
  });

  it("leaves ordinary adviser prose untouched", () => {
    expect(redactSensitiveText("Use a bounded retry with exponential backoff.")).toEqual({
      text: "Use a bounded retry with exponential backoff.",
      redacted: false,
    });
  });
});
