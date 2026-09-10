/**
 * `auth/` — OpenAI identity reuse and the isolated ChatGPT browser-session bootstrap.
 *
 * M0 fixes the safety contract (identity hints only, no silent account switching) and the module
 * boundary. Credential discovery, cookie import, and manual login land in M2 and must keep
 * `AccountIdentityHint` free of secret material.
 */

export * from "./identity.js";
