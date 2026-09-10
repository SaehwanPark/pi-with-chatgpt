/**
 * `git/` — repository detection, immutable checkpoint resolution, and remote reachability.
 *
 * Two surfaces matter to the rest of the program:
 *
 * - `resolveCheckpoint` (in `checkpoint-resolution.ts`) is the only entry point the extension layer
 *   needs: it returns a dispatch-ready `ConsultationAnchor` or a structured refusal.
 * - `createGitExecutor` (in `exec.ts`) enforces the read-only allowlist in `authority.ts` before any
 *   process is spawned, so no caller can reach git with a mutating invocation by accident (INV-06).
 */

export * from "./authority.js";
export * from "./exec.js";
export * from "./repository.js";
export * from "./ref-resolution.js";
export * from "./ancestry.js";
export * from "./remote-availability.js";
export * from "./github-api.js";
export * from "./pr-detection.js";
export * from "./checkpoint-resolution.js";
