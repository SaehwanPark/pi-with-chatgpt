/**
 * `git/` — repository detection, immutable checkpoint resolution, and remote reachability.
 *
 * M0 establishes the module boundary and the git-safety surface (`authority.ts`). Checkpoint
 * resolution, remote probing, and PR detection land in M1 and are built on the `FullCommitSha` and
 * `ConsultationAnchor` types from `protocol/`.
 */

export * from "./authority.js";
