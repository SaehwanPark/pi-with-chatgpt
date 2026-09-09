/**
 * `config/` — global and project-safe configuration.
 *
 * The schema is the whole module at M0; loading from Pi settings and the filesystem lands with the
 * runtime wiring. Anything credential-shaped is rejected by design (INV-12).
 */

export * from "./schema.js";
