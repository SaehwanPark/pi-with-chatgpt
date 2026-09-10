import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { SecretText } from "./secret-text.js";

describe("SecretText", () => {
  const SECRET = "access-token-material-xyz";

  it("hides the value from string coercion", () => {
    const secret = SecretText.from(SECRET);
    expect(String(secret)).toBe("[redacted]");
    // The template literal is the point: implicit stringification is how a secret leaks into a log line.
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    expect(`${secret}`).not.toContain(SECRET);
    expect(JSON.stringify({ secret })).not.toContain(SECRET);
    expect(JSON.stringify(secret)).not.toContain(SECRET);
    expect(inspect(secret)).not.toContain(SECRET);
  });

  it("returns the value only through expose()", () => {
    const secret = SecretText.from(SECRET);
    expect(secret.expose()).toBe(SECRET);
  });

  it("has a stable fingerprint that does not reveal the value", () => {
    const a = SecretText.from(SECRET);
    const b = SecretText.from(SECRET);
    const c = SecretText.from(`${SECRET}-other`);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(a.fingerprint).not.toContain(SECRET.slice(0, 8));
  });

  it("treats empty material as empty rather than as a secret", () => {
    expect(SecretText.from("").empty).toBe(true);
    expect(SecretText.from("x").empty).toBe(false);
  });
});
