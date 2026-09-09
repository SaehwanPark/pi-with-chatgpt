/**
 * `protocol/` — request/response contracts and the typed invariants that every other module leans on.
 *
 * This module owns vocabulary only: commit anchors, repository identity, GitHub-only context
 * references, trust brands, dependency mode, and the invariant index. It performs no I/O, so it is
 * importable from anywhere without creating a cycle. Behaviour that reads git (M1), drives the
 * browser (M3), or persists state (M6) belongs in the other module trees.
 */

export * from "./checkpoint.js";
export * from "./context-channel.js";
export * from "./dependency.js";
export * from "./invariants.js";
export * from "./provider.js";
export * from "./repo.js";
export * from "./sha.js";
export * from "./trust.js";
