import { describe, expect, it } from "vitest";

import {
  CHATGPT_SELECTORS,
  classifySurface,
  classifyTurn,
  modelMatchesLabel,
  scrubPageText,
  type SurfaceSnapshot,
} from "./chatgpt-dom.js";

function snapshot(overrides: Partial<SurfaceSnapshot> = {}): SurfaceSnapshot {
  return {
    url: "https://chatgpt.com/",
    title: "ChatGPT",
    hasComposer: true,
    hasSendButton: true,
    hasAssistantMessage: false,
    isGenerating: false,
    showsSignInPrompt: false,
    showsVerification: false,
    ...overrides,
  };
}

describe("classifySurface", () => {
  it("recognises a ready conversation", () => {
    expect(classifySurface(snapshot())).toMatchObject({ state: "conversation-ready", actionable: true });
  });

  it("recognises a streaming turn and a completed answer", () => {
    expect(classifySurface(snapshot({ isGenerating: true })).state).toBe("generating");
    expect(classifySurface(snapshot({ hasAssistantMessage: true })).state).toBe("response-complete");
  });

  it("treats a verification wall as terminal even with a composer present", () => {
    const result = classifySurface(snapshot({ showsVerification: true }));
    expect(result).toMatchObject({ state: "human-verification", actionable: false });
  });

  it("recognises a Cloudflare interstitial from the document title alone", () => {
    // A fresh headless profile routinely hits "Just a moment..." before any element renders. Treating it
    // as `unknown` invites a retry loop through the challenge; it is a human gate, full stop.
    for (const title of ["Just a moment...", "Attention Required! | Cloudflare", "Puzzle CAPTCHA"]) {
      const result = classifySurface(snapshot({ title }));
      expect(result.state, title).toBe("human-verification");
      expect(result.actionable, title).toBe(false);
    }
  });

  it("treats a sign-in shell as signed out, composer or not", () => {
    expect(classifySurface(snapshot({ showsSignInPrompt: true, hasComposer: false })).state).toBe("signed-out");
    // The signed-out landing page *does* show a text box; sending into it loses the question after login.
    expect(classifySurface(snapshot({ showsSignInPrompt: true, hasComposer: true })).state).toBe("signed-out");
  });

  it("surfaces a provider error instead of waiting it out", () => {
    expect(classifySurface(snapshot({ errorNotice: "You've reached the free limit" }))).toMatchObject({
      state: "provider-error",
      actionable: false,
    });
  });

  it("reports unknown rather than guessing on a foreign or blank page", () => {
    expect(classifySurface(snapshot({ url: "https://evil.test/", hasComposer: false })).state).toBe("unknown");
    expect(classifySurface(snapshot({ hasComposer: false })).state).toBe("unknown");
    expect(classifySurface(snapshot({ url: "not a url" })).state).toBe("unknown");
  });

  it("accepts the legacy chat.openai.com host", () => {
    expect(classifySurface(snapshot({ url: "https://chat.openai.com/c/abc" })).state).toBe("conversation-ready");
  });

  it("never reports actionable for a state the runtime cannot act on", () => {
    for (const candidate of [
      snapshot({ showsVerification: true }),
      snapshot({ showsSignInPrompt: true, hasComposer: false }),
      snapshot({ url: "https://example.test/" }),
      snapshot({ errorNotice: "boom" }),
      snapshot({ hasComposer: false }),
    ]) {
      expect(classifySurface(candidate).actionable).toBe(false);
    }
  });
});

describe("classifyTurn", () => {
  it("does not mistake a previous answer for the new one", () => {
    // This is the failure that produces confident nonsense: the old reply is still on screen the instant
    // the new question is sent.
    expect(
      classifyTurn({
        snapshot: snapshot({ hasAssistantMessage: true }),
        sent: true,
        sawOwnMessage: false,
        sawAssistantMessage: true,
      }),
    ).toBe("waiting");
  });

  it("completes only after our own message and a new answer both appear", () => {
    expect(
      classifyTurn({ snapshot: snapshot(), sent: true, sawOwnMessage: true, sawAssistantMessage: true }),
    ).toBe("complete");
  });

  it("waits while generating", () => {
    expect(
      classifyTurn({
        snapshot: snapshot({ isGenerating: true }),
        sent: true,
        sawOwnMessage: true,
        sawAssistantMessage: false,
      }),
    ).toBe("generating");
  });

  it("treats an error or a challenge as terminal for the turn", () => {
    expect(classifyTurn({ snapshot: snapshot(), sent: true, sawOwnMessage: true, sawAssistantMessage: false, errorNotice: "quota" })).toBe("error");
    expect(
      classifyTurn({ snapshot: snapshot({ showsVerification: true }), sent: true, sawOwnMessage: true, sawAssistantMessage: false }),
    ).toBe("error");
  });

  it("does nothing before the send is issued", () => {
    expect(classifyTurn({ snapshot: snapshot({ hasAssistantMessage: true }), sent: false, sawOwnMessage: false, sawAssistantMessage: true })).toBe("waiting");
  });
});

describe("modelMatchesLabel", () => {
  it("matches ids against decorated UI labels", () => {
    expect(modelMatchesLabel("gpt-5.5", "GPT-5.5")).toBe(true);
    expect(modelMatchesLabel("gpt-5.5", "GPT-5.5 (thinking)")).toBe(true);
    expect(modelMatchesLabel("gpt-5.5-auto", "GPT-5.5 Auto")).toBe(true);
    expect(modelMatchesLabel("gpt-5.5", "GPT-4o")).toBe(false);
    expect(modelMatchesLabel("gpt-5.5", undefined)).toBe(false);
  });
});

describe("scrubPageText", () => {
  it("redacts credential-shaped material", () => {
    const text =
      "Sign in with eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiY2QifQ.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlIGRhdGE and sk-proj-abcdefghijklmnopqrstuvwxyz and Bearer abcdefghijklmnop1234";
    const scrubbed = scrubPageText(text);
    expect(scrubbed).not.toContain("eyJhbGciOi");
    expect(scrubbed).not.toContain("sk-proj-abc");
    expect(scrubbed).not.toContain("abcdefghijklmnop1234");
  });

  it("redacts labelled session material", () => {
    expect(scrubPageText("session_id=abc123def456ghi789")).not.toContain("abc123def456ghi789");
    expect(scrubPageText("cookie: __Secure-__Host-next-auth=xyzxyzxyzxyz")).not.toContain("xyzxyzxyzxyz");
  });

  it("keeps ordinary notices readable and bounded", () => {
    expect(scrubPageText("  You've   hit the daily limit.  ")).toBe("You've hit the daily limit.");
    expect(scrubPageText("x".repeat(500)).length).toBeLessThanOrEqual(240);
  });
});

describe("selector sets", () => {
  it("proposes more than one candidate per interaction", () => {
    // A single selector means one markup change breaks the runtime; the fallbacks are the point.
    for (const [name, candidates] of Object.entries(CHATGPT_SELECTORS)) {
      expect(candidates.length, name).toBeGreaterThan(1);
    }
  });
});
