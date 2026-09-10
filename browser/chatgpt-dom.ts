/**
 * M3 — the ChatGPT surface, as a closed set of decisions.
 *
 * The browser gives us a URL, a title, and the presence or absence of a handful of elements. From that we
 * must answer four questions reliably: is this page ready for a question, is it asking for a human, did
 * the model finish answering, and is the account seeing something other than what we asked for. Every
 * question is answered as a pure function over a structural snapshot, so a UI change is a change to one
 * snapshot and a classifier test rather than a Playwright session.
 *
 * Two rules govern the snapshot:
 *
 * 1. **Presence, not content.** The page is untrusted input (INV-05); its text is only ever kept as the
 *    short, credential-scrubbed `explanation` the user sees. Nothing here returns page text to callers
 *    that will pass it to the worker model without that scrubing.
 * 2. **Ambiguity is an answer.** "Can't tell" is a distinct surface state (`unknown`) with `actionable:
 *    false`. A wrong-but-confident classifier turns a broken page into a wrong consultation.
 */

/** What the DOM probe found. Deliberately booleans and short strings only. */
export interface SurfaceSnapshot {
  readonly url: string;
  readonly title: string;
  /** A text entry the user types into. Absent means there is no question to ask. */
  readonly hasComposer: boolean;
  /** The control that submits the composer. */
  readonly hasSendButton: boolean;
  /** A completed answer is visible. */
  readonly hasAssistantMessage: boolean;
  /** A turn is streaming. */
  readonly isGenerating: boolean;
  /** A "Sign in" / "Log in" surface. */
  readonly showsSignInPrompt: boolean;
  /** A CAPTCHA, Cloudflare challenge, or "verify you are human" wall. */
  readonly showsVerification: boolean;
  /** An error toast or banner (rate limit, server error, model overload). */
  readonly errorNotice?: string;
  /** Notice that the requested model was not used (downgrade, fallback, capacity). */
  readonly degradedNotice?: string;
  /** Model name currently shown by the model picker. */
  readonly currentModel?: string;
}

/**
 * Hosts that are part of the ChatGPT surface. Anything else means the page navigated somewhere unexpected
 * and must not be treated as an adviser channel.
 */
const CHATGPT_HOSTS: readonly string[] = ["chatgpt.com", "chat.openai.com"];

export interface TurnSignals {
  readonly snapshot: SurfaceSnapshot;
  /** A send was issued for this turn; without it, an existing answer is not *our* answer. */
  readonly sent: boolean;
  /** A new user message appeared after the send was issued. */
  readonly sawOwnMessage: boolean;
  /** An assistant message appeared after the send was issued. */
  readonly sawAssistantMessage: boolean;
  readonly errorNotice?: string;
}

/**
 * Classify the current page.
 *
 * The order is a deliberate priority list. A verification wall on top of a ready composer is still a wall;
 * a sign-in prompt that covers a stale conversation is still signed out.
 */
export function classifySurface(snapshot: SurfaceSnapshot): {
  readonly state: "signed-out" | "human-verification" | "conversation-ready" | "generating" | "response-complete" | "provider-error" | "unknown";
  readonly explanation: string;
  readonly actionable: boolean;
} {
  if (!isChatGptUrl(snapshot.url)) {
    return {
      state: "unknown",
      explanation: `Page is not the ChatGPT surface (${hostOf(snapshot.url) ?? "unknown host"}).`,
      actionable: false,
    };
  }
  if (snapshot.showsVerification) {
    return { state: "human-verification", explanation: "Human verification is required.", actionable: false };
  }
  // A sign-in prompt is signed out unless a real conversation is on screen. The signed-out landing shell
  // *does* offer a text box, but a question typed there is discarded after login, so a composer does not
  // rescue it. A genuine logged-in session never shows a sign-in prompt, so an assistant message wins.
  if (snapshot.showsSignInPrompt && !snapshot.hasAssistantMessage) {
    return { state: "signed-out", explanation: "ChatGPT is signed out.", actionable: false };
  }
  if (snapshot.errorNotice !== undefined) {
    return { state: "provider-error", explanation: truncate(snapshot.errorNotice), actionable: false };
  }
  if (snapshot.isGenerating) return { state: "generating", explanation: "Assistant is generating.", actionable: true };
  if (snapshot.hasAssistantMessage) {
    return { state: "response-complete", explanation: "A response is present.", actionable: true };
  }
  if (snapshot.hasComposer) {
    return {
      state: "conversation-ready",
      explanation: "Ready to ask.",
      actionable: true,
    };
  }
  return { state: "unknown", explanation: "ChatGPT surface not recognised.", actionable: false };
}

/**
 * Decide whether one polling tick completes the turn.
 *
 * `sawOwnMessage` is the crux: ChatGPT keeps the previous answer on screen, so "an answer exists" is
 * routinely true before the new one arrives. Requiring our own message first is what stops a consultation
 * from returning last week's advice.
 */
export function classifyTurn(signals: TurnSignals): "complete" | "generating" | "error" | "waiting" {
  if (signals.errorNotice !== undefined || signals.snapshot.errorNotice !== undefined) return "error";
  if (signals.snapshot.showsVerification) return "error";
  if (!signals.sent) return "waiting";
  if (signals.snapshot.isGenerating) return "generating";
  if (!signals.sawOwnMessage) return "waiting";
  if (signals.sawAssistantMessage) return "complete";
  return "waiting";
}

/**
 * Whether the model shown in the picker is the one we asked for.
 *
 * Matching is on normalised words rather than exact strings because the UI renders "GPT-5.5" for an id of
 * `gpt-5.5`, and because the model may be decorated with a suffix like "(thinking)".
 */
export function modelMatchesLabel(modelId: string, label: string | undefined): boolean {
  if (label === undefined) return false;
  const needle = normaliseModelToken(modelId);
  if (needle.length === 0) return false;
  return normaliseModelToken(label).includes(needle);
}

function normaliseModelToken(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/gu, "");
}

/**
 * Scrub anything credential-shaped out of page text before it is stored or shown.
 *
 * This is a belt-and-braces measure: the DOM adapter already extracts short notices, and the Playwright
 * layer never scrapes inputs or cookies. It exists because a future contributor reading one more element
 * should not have to remember the rule.
 */
export function scrubPageText(text: string, maxLength = 240): string {
  const withoutTokens = text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, "[redacted-jwt]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/gu, "[redacted-key]")
    .replace(/(session[_ -]?id|sessionToken|__Secure-|oauth[_ -]?token|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|secret|password)[ \t]*[=:][ \t]*[^\s;,]+$/giu, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}={0,}/giu, "Bearer [redacted]")
    .replace(/cookie[ \t]*[=:][ \t]*[^\n]{4,}/giu, "cookie=[redacted]");
  const collapsed = withoutTokens.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 3)}...` : collapsed;
}

function isChatGptUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return CHATGPT_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function truncate(value: string): string {
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
}

/** Selector sets, exported so a UI change is one reviewable diff rather than a search through the driver. */
export const CHATGPT_SELECTORS = Object.freeze({
  composer: [
    '[data-testid="conversation-composer"]',
    '#prompt-textarea',
    '[role="textbox"][aria-label*="Chat with ChatGPT" i]',
    'textarea[placeholder*="message" i]',
  ],
  sendButton: [
    '[data-testid="send-button"]',
    '[aria-label="Send Prompt"]',
    '[aria-label*="Send" i]',
    'button[data-testid="composer-submit-button"]',
  ],
  userMessage: ['[data-testid="user-message"]', '.user-message', '[message-author="user"]'],
  assistantMessage: ['[data-testid="conversation-turn-assistant"]', '.markdown', '[message-author="assistant"]'],
  generating: [
    '[data-testid="result-content-appending"]',
    '[data-testid="stop-button"]',
    '[aria-label*="Stop" i]',
  ],
  signInPrompt: [
    '[data-testid="login-button"]',
    'a[href*="sign-in"]',
    'button:has-text("Sign in")',
  ],
  verification: [
    '[name^="cf-chl"]',
    'iframe[src*="challenges.cloudflare.com"]',
    ':text("Verifying you are human")',
    ':text("Verify you are human")',
    ':text("Press and hold")',
  ],
  errorNotice: ['[data-testid="banner-title"]', '[role="alert"]', '[data-is-markdown="false"].banner'],
  modelPicker: ['button[aria-label*="model" i]', '[data-testid="model-switcher"]'],
  modelOption: ['[role="menuitem"]', '[data-testid="model-switcher-menu"] [role="option"]'],
} as const);

/** URLs that establish the surface without disturbing the session. */
export const CHATGPT_URLS = Object.freeze({
  home: "https://chatgpt.com/",
  newChat: "https://chatgpt.com/",
} as const);
