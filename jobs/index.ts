/**
 * `jobs/` — synchronous and asynchronous consultation job state.
 *
 * The state machine and private, versioned job transactions preserve immutable provenance through
 * claims and terminal races. Browser scheduling and Pi wake-up are the remaining M5 integration.
 */

export * from "./state.js";
export * from "./record.js";
export * from "./store.js";
