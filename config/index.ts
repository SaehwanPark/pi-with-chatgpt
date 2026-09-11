/**
 * `config/` — global and project-safe configuration.
 *
 * The schema and the extension-owned durable state layout live here. Anything credential-shaped is
 * rejected by design (INV-12).
 */

export * from "./schema.js";
export * from "./state-layout.js";
