/**
 * The only context channels V1 allows for repository content (INV-02, INV-16).
 *
 * GitHub is the shared coordinate system between Pi and the adviser. The union is intentionally a
 * single member and is not extensible by configuration: adding `upload`, `archive`, `tunnel`, or a
 * workspace bridge is a post-V1 architectural decision, not a feature flag. Tests assert the exact
 * member list so widening it fails loudly instead of passing silently.
 */

import type { FullCommitSha } from "./sha.js";
import type { GitHubRepositoryKey } from "./repo.js";

export const V1_CONTEXT_CHANNELS = ["github"] as const;

export type ContextChannel = (typeof V1_CONTEXT_CHANNELS)[number];

export function contextChannels(): readonly ContextChannel[] {
  return V1_CONTEXT_CHANNELS;
}

/**
 * A reference the adviser can follow with its own GitHub access. `path`, `range`, and `blobUrl`
 * are GitHub URLs only; a local filesystem path is not representable in this type, which is the
 * point (INV-02).
 */
export interface GitHubContextReference {
  readonly channel: "github";
  readonly repository: GitHubRepositoryKey;
  readonly commit: FullCommitSha;
  readonly kind: "repository" | "commit" | "pull-request" | "file" | "directory" | "diff";
  readonly url: string;
  /** Repository-relative path (for example `protocol/sha.ts`); never an absolute local path. */
  readonly path?: string;
}

/**
 * Everything the adviser is told about the repository: a brief plus GitHub links. The brief text
 * itself is authored locally; file *contents* reach the adviser only because GitHub serves them.
 */
export interface ConsultationContext {
  readonly references: readonly GitHubContextReference[];
  readonly brief: string;
}

/**
 * Guard for the one place a new channel could sneak in: a caller that needs to describe context
 * must produce a `GitHubContextReference`, whose URL must be an https GitHub URL.
 */
export function isGitHubWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "github.com" || parsed.hostname === "www.github.com");
  } catch {
    return false;
  }
}
