/**
 * Graph-level drift analysis (INV-03, INV-05).
 *
 * Compares the adviser review checkpoint against the current development cursor (HEAD).
 * Detects whether the checkpoint is identical, an ancestor, a descendant, diverged,
 * or unreachable, and computes the commits ahead/behind.
 */

import type { FullCommitSha } from "../protocol/sha.js";
import type { GitExecutor } from "../git/exec.js";
import { compareCommits, aheadBehind } from "../git/ancestry.js";
import type { DriftVerdict } from "./index.js";

export interface GraphDriftOptions {
  readonly git: GitExecutor;
  readonly cwd: string;
  readonly checkpoint: FullCommitSha;
  readonly currentHead: FullCommitSha;
}

export interface GraphDriftResult {
  readonly checkpoint: FullCommitSha;
  readonly currentHead: FullCommitSha;
  readonly verdict: DriftVerdict;
  readonly commitsAhead: number; // commits HEAD has that checkpoint lacks
  readonly commitsBehind: number; // commits checkpoint has that HEAD lacks
}

/**
 * Computes graph-level git drift between an adviser checkpoint and current HEAD.
 */
export async function analyzeGraphDrift(options: GraphDriftOptions): Promise<GraphDriftResult> {
  const { git, cwd, checkpoint, currentHead } = options;

  if (checkpoint === currentHead) {
    return {
      checkpoint,
      currentHead,
      verdict: "equal",
      commitsAhead: 0,
      commitsBehind: 0,
    };
  }

  const relation = await compareCommits(git, cwd, checkpoint, currentHead);

  if (relation === undefined || relation === "unrelated") {
    return {
      checkpoint,
      currentHead,
      verdict: "unreachable",
      commitsAhead: 0,
      commitsBehind: 0,
    };
  }

  if (relation === "equal") {
    return {
      checkpoint,
      currentHead,
      verdict: "equal",
      commitsAhead: 0,
      commitsBehind: 0,
    };
  }

  const counts = await aheadBehind(git, cwd, checkpoint, currentHead);
  const commitsAhead = counts ? counts.ahead : 0;
  const commitsBehind = counts ? counts.behind : 0;

  if (relation === "left-ancestor-of-right") {
    return {
      checkpoint,
      currentHead,
      verdict: "checkpoint-is-ancestor",
      commitsAhead,
      commitsBehind: 0,
    };
  }

  if (relation === "right-ancestor-of-left") {
    return {
      checkpoint,
      currentHead,
      verdict: "checkpoint-is-descendant",
      commitsAhead: 0,
      commitsBehind,
    };
  }

  return {
    checkpoint,
    currentHead,
    verdict: "diverged",
    commitsAhead,
    commitsBehind,
  };
}
