import { describe, expect, it } from "vitest";

import { piApiKeyIdentity, piOpenAiIdentity, maskEmail, decodeJwtClaims, planHintSuggestsPaid } from "./openai-identity.js";
import { SecretText } from "./secret-text.js";

const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";
const SIGNING_MATERIAL = "super-secret-signing-material";

/** Build an unsigned JWT-shaped token; this module never verifies signatures, only reads claims. */
function fakeAccessToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.${SIGNING_MATERIAL}`;
}

/** Real Codex tokens nest these under the namespace URL, which is the shape the fixture must use. */
function chatgptClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "user-1",
    exp: 1_800_000_000,
    "https://api.openai.com/auth": {
      chatgpt_account_id: ACCOUNT_ID,
      chatgpt_plan_type: "pro",
    },
    "https://api.openai.com/profile": {
      email: "ada@example.com",
      email_verified: true,
    },
    ...overrides,
  };
}

describe("piOpenAiIdentity", () => {
  it("reads account id, masked email, and a plan hint from claims", () => {
    const identity = piOpenAiIdentity(
      {
        kind: "oauth",
        accessToken: SecretText.from(fakeAccessToken(chatgptClaims())),
        expiresAt: 1_800_000_000_000,
      },
      1_700_000_000_000,
    );
    expect(identity.source).toBe("pi-oauth");
    expect(identity.accountIdHint).toBe(ACCOUNT_ID);
    expect(identity.emailMasked).toBe("a***@example.com");
    expect(identity.planHint).toBe("pro");
    expect(identity.expired).toBe(false);
  });

  it("prefers the account id Pi stored over the token claim", () => {
    const claims = chatgptClaims();
    const nested = claims["https://api.openai.com/auth"] as Record<string, unknown>;
    nested["chatgpt_account_id"] = "claim-id";
    const identity = piOpenAiIdentity(
      {
        kind: "oauth",
        accessToken: SecretText.from(fakeAccessToken(claims)),
        expiresAt: 1_800_000_000_000,
        accountId: "stored-id",
      },
      1,
    );
    expect(identity.accountIdHint).toBe("stored-id");
  });

  it("still reads a flattened claim spelling", () => {
    // Token encoders differ; accepting both spellings keeps an issuer change from silently blanking
    // the identity, which would turn every comparison into `unknown`.
    const identity = piOpenAiIdentity(
      {
        kind: "oauth",
        accessToken: SecretText.from(fakeAccessToken({ chatgpt_account_id: "flat-id" })),
        expiresAt: 1_800_000_000_000,
      },
      1,
    );
    expect(identity.accountIdHint).toBe("flat-id");
  });

  it("degrades to a hint-less identity when the token is not a JWT", () => {
    const identity = piOpenAiIdentity(
      { kind: "oauth", accessToken: SecretText.from("opaque-token"), expiresAt: 1_800_000_000_000 },
      1,
    );
    expect(identity.accountIdHint).toBeUndefined();
    expect(identity.planHint).toBeUndefined();
    expect(identity.expiresAt).toBe(1_800_000_000_000);
  });

  it("marks an expired token without failing", () => {
    const identity = piOpenAiIdentity(
      { kind: "oauth", accessToken: SecretText.from(fakeAccessToken(chatgptClaims())), expiresAt: 10 },
      20,
    );
    expect(identity.expired).toBe(true);
  });

  it("never carries token material into the identity or its serialisation", () => {
    const identity = piOpenAiIdentity(
      { kind: "oauth", accessToken: SecretText.from(fakeAccessToken(chatgptClaims())), expiresAt: 1 },
      2,
    );
    const serialized = JSON.stringify(identity);
    expect(serialized).not.toContain(SIGNING_MATERIAL);
    expect(serialized).not.toContain("ada@example.com");
    // The account id is intentionally present: it is the comparison key, and it is not a secret.
    expect(serialized).toContain(ACCOUNT_ID);
  });

  it("gives an api-key credential no identity at all", () => {
    // An API key is transport, not an account; pretending otherwise lets a mismatch read as a match.
    expect(piApiKeyIdentity()).toEqual({ source: "none" });
  });
});

describe("maskEmail", () => {
  it.each([
    ["ada@example.com", "a***@example.com"],
    ["a.b.c@sub.example.org", "a***@sub.example.org"],
    ["no-domain", "***"],
  ])("masks %s as %s", (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
});

describe("decodeJwtClaims", () => {
  it("returns undefined for anything that is not a three-segment token", () => {
    expect(decodeJwtClaims("")).toBeUndefined();
    expect(decodeJwtClaims("a.b")).toBeUndefined();
    expect(decodeJwtClaims("a.::not base64 json::.c")).toBeUndefined();
  });
});

describe("planHintSuggestsPaid", () => {
  it("labels free tiers honestly and stays a hint", () => {
    expect(planHintSuggestsPaid("free")).toBe(false);
    expect(planHintSuggestsPaid("FREE")).toBe(false);
    expect(planHintSuggestsPaid("plus")).toBe(true);
    expect(planHintSuggestsPaid(undefined)).toBeUndefined();
  });
});
