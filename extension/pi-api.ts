/**
 * The slice of the Pi extension API this package uses.
 *
 * Deliberately a structural type instead of a devDependency on `@earendil-works/pi-coding-agent`:
 * the full package is a heavy install for a package whose runtime contract with Pi is this narrow,
 * and a structural type keeps the used surface explicit and reviewable. Drift from Pi's published
 * `ExtensionAPI` is caught by the Pi-load smoke test (`npm run smoke:pi`, added at M0, extended at
 * M8), which loads the *built* extension inside a real Pi installation.
 *
 * Reference: pi `docs/extensions.md`.
 */

/** Pi-side notification surface available to command handlers and event handlers. */
export interface AdviserUi {
  notify(message: string, severity?: "info" | "warning" | "error"): void;
}

/**
 * The part of Pi's read-only session manager used for consultation scoping.
 *
 * Pi does not expose a `sessionId` convenience property on command contexts. The stable
 * identity is obtained from `ctx.sessionManager.getSessionId()` and must remain the source of
 * task/conversation and async delivery isolation.
 */
export interface AdviserSessionManager {
  getSessionId(): string;
}

/** Minimal context shared by Pi lifecycle handlers and agent tools. */
export interface AdviserExtensionContext {
  readonly cwd: string;
  readonly sessionManager: AdviserSessionManager;
  readonly ui: AdviserUi;
  /** Pi's trust gate; untrusted workspaces cannot trigger adviser automation. */
  readonly isProjectTrusted?: () => boolean;
}

/**
 * Tool calls in unit fixtures may omit Pi's context argument; live Pi always supplies the full
 * `ExtensionContext`. Keeping these fields optional at this boundary lets read-only tools remain
 * directly callable while submission tools reject missing session identity instead of inventing one.
 */
export interface AdviserToolContext {
  readonly cwd?: string;
  readonly sessionManager?: AdviserSessionManager;
  readonly ui?: AdviserUi;
  readonly isProjectTrusted?: () => boolean;
}

export interface AdviserCommandContext {
  readonly ui: AdviserUi;
  /** Absolute path of the workspace Pi was started in, when there is one. */
  readonly cwd: string;
  /** Stable Pi session identity used for adviser task and wake-up routing. */
  readonly sessionManager: AdviserSessionManager;
  /** Pi's trust gate; untrusted workspaces cannot trigger adviser automation. */
  readonly isProjectTrusted?: () => boolean;
}

export interface AdviserCommandDefinition {
  readonly description: string;
  handler(args: string, ctx: AdviserCommandContext): void | Promise<void>;
}

export interface AdviserToolDefinition<TParams = unknown, TDetails = unknown> {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: AdviserToolContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: TDetails }>;
}

/**
 * Minimal view of Pi's `ExtensionAPI`: enough to register commands and tools and to observe the
 * session lifecycle. New members are added only when a milestone actually uses them.
 */
export interface AdviserExtensionApi {
  registerCommand(name: string, definition: AdviserCommandDefinition): void;
  registerTool?(tool: AdviserToolDefinition<unknown, unknown>): void;
  on(event: string, handler: (payload: unknown, ctx: AdviserExtensionContext) => void | Promise<void>): void;
}

/**
 * Read the real Pi session identity from an extension context.
 *
 * Throwing when the context is malformed is intentional: silently substituting a shared
 * `session-default` would collapse unrelated Pi tasks onto one adviser conversation.
 */
export function getPiSessionId(ctx: Pick<AdviserExtensionContext, "sessionManager">): string {
  const sessionId = ctx.sessionManager.getSessionId();
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("Pi session manager returned an empty session ID");
  }
  return sessionId;
}

/** A missing trust capability is not proof of trust; adviser automation must fail closed. */
export function isPiProjectTrusted(ctx: Pick<AdviserExtensionContext, "isProjectTrusted"> | undefined): boolean {
  if (ctx?.isProjectTrusted === undefined) return false;
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

/**
 * Lowest Pi release this extension is tested against. Bump only with a documented reason; the
 * value is asserted against the installation by the Pi-load smoke test.
 */
export const MIN_PI_VERSION = "0.85.1";
