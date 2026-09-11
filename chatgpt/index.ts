/**
 * `chatgpt/` — ChatGPT Project and conversation management.
 *
 * M4 implements the scoping rules: one Project per canonical repository, one conversation per task and
 * request kind, durable mappings, race-safe creation, and same-Project recovery.
 */

export * from "./scope.js";
export * from "./task-identity.js";
export * from "./project-instructions.js";
export * from "./project-mapping.js";
export * from "./conversation-mapping.js";
export * from "./conversation-recovery.js";
