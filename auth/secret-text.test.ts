import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { SecretText } from "./secret-text.js";

/** Escape hatch for the two assertions that deliberately try to misuse an instance. */
function asRecord(secret: SecretText): Record<string, unknown> {
  return secret as unknown as Record<string, unknown>;
}

/**
 * A `#private` field is not reachable by string key, and that is the claim being asserted here: poking
 * at the instance the way a debug dumper would must yield nothing, not the plaintext.
 */
function peekPrivate(secret: SecretText): unknown {
  return asRecord(secret)["#value"];
}

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

  /**
   * Every accidental serialisation route, enumerated.
   *
   * One assertion per route rather than one big assertion: a future refactor that adds a `valueOf`, a
   * `Symbol.toPrimitive`, or a getter for debugging purposes breaks exactly one line, and that line names
   * the route to fix. `Error.stack` and deep `inspect` are here because those are where secrets actually
   * end up in practice — the route someone adds later is usually reached through one of them.
   */
  it("stays hidden across every accidental serialisation route", () => {
    const secret = SecretText.from(SECRET);
    // Two routes below coerce on purpose: the claim under test is that implicit stringification still
    // yields no secret, which cannot be asserted without performing the coercion the rule forbids.
    /* eslint-disable @typescript-eslint/restrict-template-expressions */
    const routes: Record<string, string> = {
      "template literal": `${secret}`,
      concat: `x${secret}`,
      "JSON of itself": JSON.stringify(secret),
      "JSON nested": JSON.stringify({ auth: { token: secret }, list: [secret] }),
      "inspect shallow": inspect(secret),
      "inspect nested": inspect({ auth: { token: secret }, map: new Map([["k", secret]]), set: new Set([secret]) }),
      "error message": new Error(`failed: ${String(secret)}`).message,
      "error stack": new Error(String(secret)).stack ?? "",
      spread: inspect({ ...secret }),
      "object values": inspect(Object.values(secret)),
      "array coercion": `${[secret].sort()}`,
      "private field poke": inspect(peekPrivate(secret)),
      "JSON round-trip": JSON.stringify(JSON.parse(JSON.stringify({ secret }))),
    };
    /* eslint-enable @typescript-eslint/restrict-template-expressions */
    for (const [route, text] of Object.entries(routes)) {
      expect(text, `serialisation route leaked: ${route}`).not.toContain(SECRET);
    }
  });

  it("cannot be mutated after construction", () => {
    const secret = SecretText.from(SECRET);
    // Frozen so a debugger helper cannot attach the plaintext as an enumerable property for later.
    expect(Object.isFrozen(secret)).toBe(true);
    expect(() => {
      asRecord(secret).leak = secret.expose();
    }).toThrow();
    expect(inspect(secret)).not.toContain(SECRET);
  });

  it("treats empty material as empty rather than as a secret", () => {
    expect(SecretText.from("").empty).toBe(true);
    expect(SecretText.from("x").empty).toBe(false);
  });
});
