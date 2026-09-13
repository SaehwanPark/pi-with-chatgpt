import type { AccountIdentityHint } from "../auth/identity.js";

/**
 * M3 — the contract between the consultation engine and the browser that carries it.
 *
 * Two rules shape everything here.
 *
 * **The browser is extension-owned, never worker-operated** (INV-01/INV-11). The worker asks for advice;
 * it never receives a page, a handle, a selector, or a script to run. So nothing in this file exposes a
 * `Page`, a `Locator`, `evaluate`, or an arbitrary-URL navigation — the only entry point is
 * {@link AdviserBrowserRuntime.consult}, whose parameters are a prompt string and a model hint. Anything
 * a caller could inject is a *value* the driver types into a composer, never code it executes.
 *
 * **Playwright is a detail behind {@link AdviserPageDriver}.** Every lifecycle rule worth testing — lazy
 * start, reuse when healthy, crash recovery, bounded polling, diagnostics that exclude credentials — is
 * tested against a fake driver in milliseconds. The real driver is the thinnest layer that can be written,
 * because that is the only part that cannot be tested hermetically.
 *
 * Note what is deliberately *absent*: any method that could click, type into, or read an arbitrary page.
 * {@link AdviserLoginPort} set that precedent in M2 and this file keeps it.
 */

/** Lifecycle of the single extension-owned browser, as observed by callers. */
export type RuntimePhase =
  /** Nothing launched; no browser process exists. */
  | "stopped"
  /** A launch is in flight (only observable because launching takes seconds). */
  | "starting"
  /** Live and healthy: reusable without further setup. */
  | "ready"
  /** Launched but unusable — crashed process, dead tab, or a page that stopped answering. */
  | "degraded"
  /** A shutdown is in flight. */
  | "stopping"
  /** Startup failed hard enough that retrying without human help is pointless. */
  | "failed";

export type RuntimeRejection =
  /** No system Chrome (or the configured channel) was found. */
  | "chrome-not-found"
  /** Chrome exists but refused to start with the extension-owned profile. */
  | "launch-failed"
  /** The profile directory is not usable (missing, wrong ownership, or wrong mode). */
  | "profile-unusable"
  /** Another process holds the profile; sharing it would corrupt both. */
  | "profile-locked-by-other-process"
  /** The page never reached a state the runtime recognised. */
  | "surface-unrecognised"
  /** A required interaction was blocked by a login or challenge page. */
  | "needs-human";

/** Why the runtime is asking for a browser: affects how eagerly it recovers. */
export type RuntimePurpose = "capability-probe" | "consultation" | "manual-login" | "model-discovery";

export interface RuntimeStartOptions {
  readonly purpose: RuntimePurpose;
  /**
   * When true, a visible window is required (manual login: a person has to type). A capability probe runs
   * headless where possible, because a window the worker is waiting on is user-hostile.
   */
  readonly headed?: boolean;
  readonly timeoutMs?: number;
}

export interface ConsultationRequest {
  /** Identifier for diagnostics and the ledger; never sent to the page. */
  readonly consultationId: string;
  /**
   * The composed brief. Treated as data: typed into the composer, never interpolated into a selector,
   * URL, or script.
   */
  readonly prompt: string;
  /** Model id already resolved by `browser/model-selection.ts`; the runtime never guesses one. */
  readonly modelId: string;
  /**
   * Commit SHA this consultation is anchored to, recorded for diagnostics only. It is *not* placed in the
   * page: the brief already contains the GitHub URLs the adviser is allowed to see (INV-03/INV-04).
   */
  readonly checkpointSha?: string;
  readonly timeoutMs?: number;
  /** Cancellation requested by the owning job; the driver stops polling before the tab is reused. */
  readonly signal?: AbortSignal;
}

export type ConsultationOutcome =
  | {
      readonly ok: true;
      /**
       * The assistant turn as read off the page: untrusted adviser output (INV-05), deliberately *not*
       * credential-scrubbed or length-bounded the way `explanation` is, because a truncated answer is a
       * broken consultation. Whoever hands this to a worker model must brand it as adviser-authored
       * (`protocol/trust.ts`) rather than pass it on as a plain string; M6's prompt assembler owns that.
       */
      readonly text: string;
      /** Wall-clock milliseconds spent waiting for the assistant turn. */
      readonly elapsedMs: number;
      /** True when the turn completed but the surface reported a degraded model or fallback. */
      readonly degraded?: string;
    }
  | {
      readonly ok: false;
      readonly failure: ConsultationFailure;
    };

export type ConsultationFailure =
  /** The composer or send control was never found: the UI changed or the page is not ChatGPT. */
  | "composer-missing"
  /** No assistant turn completed within the bounded wait. */
  | "generation-timeout"
  /** The page showed a provider-side error (quota, server error, model unavailable). */
  | "provider-error"
  /** Login or human verification is required before the question can be asked. */
  | "needs-human"
  /** The requested model is not selectable on this account. */
  | "model-unavailable"
  /** The browser died mid-turn; the caller may retry after recovery. */
  | "browser-lost"
  /** The response was produced but could not be read reliably. */
  | "response-unreadable";

/** Structured snapshot for the status surface. Never contains page content. */
export interface RuntimeStatus {
  readonly phase: RuntimePhase;
  /** Whether a browser process is actually alive (a stale "ready" is a bug this field catches). */
  readonly processAlive: boolean;
  readonly headed: boolean;
  readonly profileDir: string;
  readonly chromeVersion?: string;
  /** Count of launches in this process; a high number means crash-restart thrashing. */
  readonly launchCount: number;
  readonly lastFailure?: RuntimeRejection | ConsultationFailure;
  readonly humanAttentionRequired: boolean;
}

/**
 * What the page is doing, as a closed set. The adapter maps a DOM to exactly one of these; "unknown" is a
 * real answer, not a placeholder, because a silent "probably fine" is how a UI change becomes a wrong
 * consultation.
 */
export type SurfaceState =
  | "signed-out"
  | "human-verification"
  | "conversation-ready"
  | "generating"
  | "response-complete"
  | "provider-error"
  | "unknown";

export interface SurfaceObservation {
  readonly state: SurfaceState;
  /**
   * Short human-facing explanation, sanitised of anything credential-shaped. Page text is untrusted
   * (INV-05) and reaches the worker only through this bounded field.
   */
  readonly explanation?: string;
  /**
   * A stable account hint only when the browser surface actually exposed one. The browser adapter must
   * leave this absent when it cannot identify the signed-in account; callers must never copy the Pi
   * credential into this field as a substitute for observation.
   */
  readonly identity?: AccountIdentityHint;
  /** Whether the runtime can proceed without a person. */
  readonly actionable: boolean;
}

export interface ModelOption {
  readonly modelId: string;
  readonly displayName: string;
  /** True when the account can select it right now. */
  readonly available: boolean;
  /** Present when unavailable, e.g. "plan", "rate-limit", "beta-gated". */
  readonly unavailableReason?: string;
}

/**
 * The seam the real Playwright code implements. Kept deliberately narrow: ten methods, none of which
 * accept a selector or a script from the caller.
 */
export interface AdviserPageDriver {
  /** Serialize a complete browser operation across the runtime and the Project/conversation surface. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  /** Start (or return the running) browser+context rooted at the extension-owned profile. */
  start(options: RuntimeStartOptions): Promise<{ readonly chromeVersion: string }>;
  /** False when the process died or the page stopped answering; the runtime then restarts. */
  isHealthy(): Promise<boolean>;
  /** Close a stale tab and reuse the browser process where possible. */
  resetTab(): Promise<void>;
  /** Classify the current page without navigating. */
  observeSurface(): Promise<SurfaceObservation>;
  /** Open the ChatGPT surface, leaving sign-in state untouched. */
  openChatGPT(): Promise<SurfaceObservation>;
  /** Read the models the account can currently select. */
  listModels(): Promise<readonly ModelOption[]>;
  /** Select a model by id; false means the id is not selectable, never "tried anyway". */
  selectModel(modelId: string): Promise<boolean>;
  /** Type the prompt, send it, and wait for the assistant turn to complete within `timeoutMs`. */
  askAndAwaitTurn(request: ConsultationRequest): Promise<ConsultationOutcome>;
  /** Flush and close everything owned by this driver. */
  shutdown(): Promise<void>;
}

/** The object the rest of the extension holds. */
export interface AdviserBrowserRuntime {
  status(): Promise<RuntimeStatus>;
  ensureReady(options?: RuntimeStartOptions): Promise<{ readonly ok: boolean; readonly rejection?: RuntimeRejection }>;
  probeSurface(): Promise<SurfaceObservation>;
  discoverModels(): Promise<{ readonly ok: boolean; readonly models?: readonly ModelOption[]; readonly rejection?: RuntimeRejection }>;
  consult(request: ConsultationRequest): Promise<ConsultationOutcome>;
  shutdown(): Promise<void>;
}

/**
 * Diagnostic artifact policy. A screenshot or DOM dump is the difference between a fixable bug and a
 * mystery, and is also the easiest way to publish a session cookie. The rules are therefore stated as
 * data so the writer and its test agree.
 */
export const DIAGNOSTIC_POLICY = Object.freeze({
  /** Screenshots are captured only after the surface is known to be past login. */
  screenshotsAfterLoginOnly: true,
  /** DOM dumps keep structural tags but drop attribute values matching this pattern. */
  redactedAttributePattern:
    /(^|[-_])(cookie|token|secret|apikey|api_key|password|authorization|session|auth)([-_]|$)/iu,
  /** Diagnostics older than this are deleted on the next launch. */
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  /** Hard cap on retained artifacts, oldest first out. */
  maxArtifacts: 20,
} as const);

/**
 * M4 — the ChatGPT Project / conversation surface.
 *
 * Separate from {@link AdviserPageDriver} because the rules differ: the page driver answers "is the page
 * usable and did a turn complete", this answers "does this Project exist, create it, start a conversation
 * in it". Kept in `browser/` so `chatgpt/` can consume it without importing Playwright, and kept as
 * deliberately narrow as the driver:
 *
 * - Every parameter is an **identifier this extension minted**, never a URL, a selector, a script, or a
 *   page handle. There is no method that could navigate the adviser somewhere the extension did not
 *   choose, and no method that could send text other than the Project instructions and a new conversation.
 * - Creation and inspection are separate calls because the mapping layer must be able to *verify* before
 *   it creates; that ordering is what stops a duplicate Project (INV-08).
 */

/** A Project as ChatGPT reports it. `url` is display/ops metadata only — nothing navigates by it. */
export interface ProjectSummary {
  readonly projectId: string;
  readonly title: string;
  /** Canonical ChatGPT URL, retained for operator navigation but never treated as identity. */
  readonly projectUrl: string;
}

/**
 * Whether a Project this extension recorded is still there.
 *
 * `unknown` is a real answer and must never be collapsed into `gone`: recreating a Project because a
 * request timed out would leave two Projects for one repository (INV-08) and orphan the first one's
 * conversations.
 */
export type ProjectInspection =
  | { readonly state: "present"; readonly title: string; readonly projectUrl?: string }
  | { readonly state: "gone" }
  | { readonly state: "unknown"; readonly reason: "network" | "needs-human" | "surface-unrecognised" };

export type ProjectCreationFailure =
  | "name-taken"
  | "needs-human"
  | "surface-unrecognised"
  | "provider-error"
  | "browser-lost";

export type ProjectCreationResult =
  | {
      readonly ok: true;
      readonly projectId: string;
      readonly title: string;
      readonly projectUrl: string;
      /** False means the Project exists but its standing instructions could not be confirmed yet. */
      readonly instructionsApplied: boolean;
    }
  | { readonly ok: false; readonly reason: ProjectCreationFailure };

export type ProjectListFailure = Exclude<ProjectCreationFailure, "name-taken">;

/** Listing failure is explicit; an empty list is never used as a synonym for an unreadable surface. */
export type ProjectListResult =
  | { readonly ok: true; readonly projects: readonly ProjectSummary[] }
  | { readonly ok: false; readonly reason: ProjectListFailure };

export type ConversationInspection =
  | { readonly state: "live"; readonly title?: string; readonly conversationUrl?: string }
  | { readonly state: "gone" }
  | { readonly state: "unknown"; readonly reason: "network" | "needs-human" | "surface-unrecognised" };

export type ConversationStartFailure = ProjectCreationFailure;

export type ConversationStartResult =
  | { readonly ok: true; readonly conversationId: string; readonly conversationUrl: string }
  | { readonly ok: false; readonly reason: ConversationStartFailure };

export interface AdviserProjectSurface {
  /** Titles and ids of the Projects visible to the signed-in adviser account. */
  listProjects(): Promise<ProjectListResult>;
  inspectProject(projectId: string): Promise<ProjectInspection>;
  /** Create a Project. The caller has already checked `inspectProject`/`listProjects` (INV-08). */
  createProject(input: { readonly title: string; readonly instructions: string }): Promise<ProjectCreationResult>;
  /** Replace a Project's instructions. False means "could not verify it was written". */
  applyInstructions(projectId: string, instructions: string): Promise<boolean>;
  /** Open a fresh conversation inside an existing Project (INV-09). */
  startConversation(projectId: string): Promise<ConversationStartResult>;
  inspectConversation(conversationId: string): Promise<ConversationInspection>;
}
