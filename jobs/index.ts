/**
 * `jobs/` — synchronous and asynchronous consultation job state.
 *
 * M0 fixes the state machine and delivery addressing. The engine that owns processes, retries, and
 * wake-up lands in M5 on top of these transitions.
 */

export * from "./state.js";
