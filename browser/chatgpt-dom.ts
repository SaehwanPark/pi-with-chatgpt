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
  // A Cloudflare/interstitial challenge is often only visible in the document title — "Just a moment..."
  // and "Attention Required" are its standard signatures, and a fresh headless profile hits it constantly.
  // Detecting it here is what turns a blank-looking page into a terminal human gate rather than an
  // "unknown" the caller might retry through.
  if (snapshot.showsVerification || titleIndicatesChallenge(snapshot.title)) {
    // The title is page-controlled text and this explanation is shown to a person, so it is bounded and
    // credential-scrubbed like every other page-derived string. An unbounded title is also how one long
    // <title> turns a status line into a paragraph.
    const reason = scrubPageText(snapshot.title, 120) || "challenge";
    return { state: "human-verification", explanation: `Human verification required (${reason}).`, actionable: false };
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
 * Whether an assistant answer arrived *after* the send rather than merely being on screen.
 *
 * The two counts must come from the same selector set, taken before the send and now. A conversation
 * already shows an answer the moment we type into it — a second turn, a restored thread, a shared link —
 * and presence alone cannot tell that answer from the one we asked for. The expression this replaces,
 * `hasNow && (!hadBefore || hasNow)`, reduces to `hasNow`, and let the previous answer be recorded as
 * this consultation's advice.
 *
 * Counting only grows an answer that appears; a regenerated answer in the same node therefore reads as
 * "still waiting". That is the deliberate direction: a timeout is recoverable and honest, an attributed
 * answer that was never generated for this brief is neither.
 */
export function assistantAnswerIsNew(assistantCountBefore: number, assistantCountNow: number): boolean {
  return assistantCountNow > assistantCountBefore;
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

/** Cloudflare / bot-management interstitial titles, matched case-insensitively on the page title. */
const CHALLENGE_TITLE_PATTERNS: readonly RegExp[] = [
  /just a moment/iu,
  /attention required/iu,
  /verify you are human/iu,
  /checking (?:your browser|if the)/iu,
  /one more step/iu,
  /puzzle (?:captcha|challenge)/iu,
];

export function titleIndicatesChallenge(title: string): boolean {
  const value = title.trim();
  if (value.length === 0) return false;
  return CHALLENGE_TITLE_PATTERNS.some((pattern) => pattern.test(value));
}

function isChatGptUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return CHATGPT_HOSTS.includes(host);
  } catch {
    return false;
  }
}

/** Host guard for secondary surfaces such as Projects; callers must not trust a redirected page. */
export function isChatGptSurfaceUrl(url: string): boolean {
  return isChatGptUrl(url);
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
  // Observed on the live signed-out home page: the affordance reads "Log in" (US build) and links point at
  // /login and /signup, not /sign-in. Keeping both spellings so a locale or copy change does not blind the
  // classifier into reading a signed-out shell as a ready conversation.
  signInPrompt: [
    '[data-testid="login-button"]',
    'a[href*="sign-in"]',
    'a[href$="/login"]',
    'a[href*="/signup"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'a:has-text("Log in")',
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
  // M4: Project and conversation management. Selector sets, like every other set here, are a fallback
  // chain rather than one guess — and the caller treats "none matched" as `surface-unrecognised`, never
  // as success.
  projectCard: ['[data-testid="project-card"]', 'a[href*="/p/"]', 'a[href*="/project/"]'],
  newProject: [
    '[data-testid="create-project-button"]',
    'button:has-text("New project")',
    '[aria-label*="New project" i]',
  ],
  projectNameInput: [
    '[data-testid="project-name-input"]',
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]',
  ],
  projectInstructions: [
    '[data-testid="project-custom-instruction-input"]',
    'textarea[aria-label*="instruction" i]',
    'textarea[placeholder*="instruction" i]',
  ],
  projectSave: ['[data-testid="project-save-button"]', 'button:has-text("Save")', 'button:has-text("Create")'],
  projectNewChat: ['[data-testid="project-new-chat"]', 'button:has-text("New chat")', 'a:has-text("New chat")'],
  deletedConversation: [
    ':text("chat is unavailable")',
    ':text("This chat may have been deleted")',
    ':text("Conversation not found")',
  ],
  projectUnavailable: [
    ':text("Project not found")',
    ':text("Project unavailable")',
    ':text("This project may have been deleted")',
  ],
} as const);

/** URLs that establish the surface without disturbing the session. */
export const CHATGPT_URLS = Object.freeze({
  home: "https://chatgpt.com/",
  newChat: "https://chatgpt.com/",
  projects: "https://chatgpt.com/project",
  /** Template for a Project page. Nothing else may navigate: ids are opaque and never user text. */
  project: (projectId: string): string => `https://chatgpt.com/p/${encodeURIComponent(assertOpaqueId(projectId))}`,
  conversation: (conversationId: string): string =>
    `https://chatgpt.com/g/${encodeURIComponent(assertOpaqueId(conversationId))}`,
} as const);

/**
 * Ids this module is asked to build URLs from are ids we or ChatGPT minted, and they must stay opaque.
 * A dot or slash in one would let a stored identifier walk the browser to an arbitrary page (INV-02:
 * ChatGPT is the only site the adviser surface opens).
 */
function assertOpaqueId(value: string): string {
  if (!/^[A-Za-z0-9_-]{4,120}$/u.test(value)) {
    throw new Error(`Refusing to build an adviser URL from "${value.slice(0, 24)}": not an opaque id.`);
  }
  return value;
}

/**
 * M4 — Projects and conversations as pure decisions.
 *
 * Same rule as the surface classifier: the DOM is untrusted, so this module takes already-extracted
 * hrefs and labels and returns ids, presence, and matches. Playwright only ever supplies strings.
 */

import type { ConversationInspection, ProjectInspection, SurfaceState } from "./runtime-types.js";

/** One Project as the Projects list reports it. */
export interface ProjectEntry {
  readonly projectId: string;
  readonly title: string;
}

export interface ProjectCardSnapshot {
  readonly href: string | undefined;
  readonly label: string | undefined;
}

/**
 * Extract the Project id from a Projects-list link.
 *
 * ChatGPT routes Projects as `/p/<id>` or `/project/<id>` depending on the build; anything else is not a
 * Project link. A missing id means the card was unreadable, which is reported as absent rather than
 * guessed from position.
 */
export function parseProjectIdFromHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  const pathname = safeChatGptPathname(href);
  const match = pathname === undefined ? undefined : /^\/(?:p|project)\/([A-Za-z0-9_-]{4,120})\/?$/u.exec(pathname);
  return match?.[1];
}

/** Turn scraped cards into entries, dropping the ones that carry no usable id or title. */
export function parseProjectEntries(cards: readonly ProjectCardSnapshot[]): readonly ProjectEntry[] {
  const entries: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const projectId = parseProjectIdFromHref(card.href);
    const title = card.label?.trim();
    if (projectId === undefined || title === undefined || title.length === 0) continue;
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    entries.push({ projectId, title });
  }
  return entries;
}

/**
 * Exact-title match, which is what makes Project creation race-safe: two Pi sessions deriving the same
 * title from the same repository find each other's Project instead of each creating one (INV-08).
 */
export function findProjectByTitle(
  entries: readonly ProjectEntry[],
  title: string,
): ProjectEntry | undefined {
  const wanted = title.trim();
  return entries.find((entry) => entry.title.trim() === wanted);
}

/**
 * Is the Project we recorded still there?
 *
 * `gone` requires positive evidence: a Projects list that loaded and does not contain the id. A signed-out
 * or unrecognised page is `unknown`, because treating it as absent would recreate a Project on a network
 * blip and leave two Projects for one repository.
 */
export function classifyProjectPresence(
  entries: readonly ProjectEntry[] | undefined,
  projectId: string,
  page: { readonly signedOut: boolean; readonly loaded: boolean; readonly needsHuman?: boolean },
): ProjectInspection {
  if (page.needsHuman === true) return { state: "unknown", reason: "needs-human" };
  if (page.signedOut) return { state: "unknown", reason: "needs-human" };
  if (!page.loaded || entries === undefined) return { state: "unknown", reason: "surface-unrecognised" };
  const match = entries.find((entry) => entry.projectId === projectId);
  if (match !== undefined) return { state: "present", title: match.title };
  return { state: "gone" };
}

/** What a conversation page says about itself, before any of it becomes an id or a verdict. */
export interface ConversationPageSignals {
  /** The M3 surface classification for the same page: the single source of "is this usable". */
  readonly surface: SurfaceState;
  /** Positive page evidence that the chat was deleted or is unavailable. */
  readonly showsDeletedNotice: boolean;
}

/**
 * Is the recorded conversation still openable?
 *
 * `gone` needs positive evidence (the page says the chat is gone). A sign-in wall, a challenge, or a
 * provider error is `unknown`: replacing a conversation on that evidence would orphan the thread that
 * still holds the task's context, and a live conversation the probe failed to read is the more likely
 * explanation.
 */
export function classifyConversationPresence(signals: ConversationPageSignals): ConversationInspection {
  if (signals.surface === "signed-out" || signals.surface === "human-verification") {
    return { state: "unknown", reason: "needs-human" };
  }
  if (signals.showsDeletedNotice) return { state: "gone" };
  if (signals.surface === "conversation-ready" || signals.surface === "generating" || signals.surface === "response-complete") {
    return { state: "live" };
  }
  if (signals.surface === "provider-error") return { state: "unknown", reason: "network" };
  return { state: "unknown", reason: "surface-unrecognised" };
}

/** Conversation ids come from the URL (`/c/<id>` or `/g/<id>`); nothing else is trusted as an id. */
export function parseConversationIdFromHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  const pathname = safeChatGptPathname(href);
  const match = pathname === undefined ? undefined : /^\/(?:c|g|chat)\/([A-Za-z0-9_-]{4,120})\/?$/u.exec(pathname);
  return match?.[1];
}

function safeChatGptPathname(href: string): string | undefined {
  try {
    const url = new URL(href, CHATGPT_URLS.home);
    return isChatGptUrl(url.toString()) ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}
