/**
 * `browser/` — the extension-owned, isolated ChatGPT browser runtime.
 *
 * Owns the isolation boundary (INV-11): the {@link AdviserProfile} can only point at a directory this
 * extension created, never the user's browser. On top of it sits the M3 runtime — a lifecycle state
 * machine, the ChatGPT surface classifier, model selection, and post-login diagnostics.
 *
 * Deliberately absent from this barrel: `adviser-runtime.js` and `playwright-driver.js`'s eager launcher.
 * Importing those pulls in `playwright-core`; the browser is a deep dependency the command layer wires only
 * when a consultation or manual login actually needs Chrome. Reach for the deep import in that layer.
 */

export * from "./profile.js";
export * from "./state-storage.js";
export * from "./chrome-state.js";
export * from "./cookie-import.js";
export * from "./capability.js";
export * from "./capability-checks.js";
export * from "./runtime-types.js";
export * from "./runtime.js";
export * from "./chatgpt-dom.js";
export * from "./model-selection.js";
export * from "./diagnostics.js";
