/**
 * `browser/` — the extension-owned, isolated ChatGPT browser runtime.
 *
 * M0 fixes profile ownership (INV-11). The Playwright runtime that drives system Chrome with this
 * profile, model selection, and the request/response round trip land in M3 on top of
 * `AdviserProfile`.
 */

export * from "./profile.js";
