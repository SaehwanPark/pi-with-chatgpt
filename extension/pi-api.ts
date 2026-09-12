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

export interface AdviserCommandContext {
  readonly ui: AdviserUi;
  /** Absolute path of the workspace Pi was started in, when there is one. */
  readonly cwd?: string;
  readonly sessionId?: string;
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
    ctx?: unknown,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: TDetails }>;
}

/**
 * Minimal view of Pi's `ExtensionAPI`: enough to register commands and tools and to observe the
 * session lifecycle. New members are added only when a milestone actually uses them.
 */
export interface AdviserExtensionApi {
  registerCommand(name: string, definition: AdviserCommandDefinition): void;
  registerTool?(tool: AdviserToolDefinition<unknown, unknown>): void;
  on(event: string, handler: (payload: unknown, ctx: AdviserCommandContext) => void | Promise<void>): void;
}

/**
 * Lowest Pi release this extension is tested against. Bump only with a documented reason; the
 * value is asserted against the installation by the Pi-load smoke test.
 */
export const MIN_PI_VERSION = "0.85.1";
