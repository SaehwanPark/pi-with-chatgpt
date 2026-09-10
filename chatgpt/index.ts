/**
 * `chatgpt/` — ChatGPT Project and conversation management.
 *
 * M0 fixes the scoping rules: one Project per canonical repository, one conversation per task and
 * request kind. Project detection/creation and conversation I/O land in M4 on these keys.
 */

export * from "./scope.js";
