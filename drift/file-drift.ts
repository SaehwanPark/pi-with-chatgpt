/**
 * File-level drift analysis (INV-05, INV-06).
 *
 * Extracts files mentioned in adviser responses, determines which files changed
 * between the reviewed checkpoint and current HEAD using read-only `git diff`,
 * and computes direct overlap and related context changes.
 */

import type { GitExecutor } from "../git/exec.js";
import type { FullCommitSha } from "../protocol/sha.js";

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  readonly path: string;
  readonly status: FileChangeStatus;
  readonly oldPath?: string;
}

export interface RelevantFileDrift {
  readonly changedFiles: readonly FileChange[];
  readonly mentionedFiles: readonly string[];
  /** Files referenced in advice that changed between checkpoint and HEAD. */
  readonly directlyAffectedFiles: readonly string[];
  /** Config, test, or nearby files changed that may impact the referenced components. */
  readonly relatedContextFiles: readonly string[];
}

/** Regex to match file paths with extensions in backticks or whitespace boundaries. */
const BACKTICK_FILE_REGEX = /`([^`\s]+\.[a-zA-Z0-9_-]{1,10})`/gu;
const GENERAL_PATH_REGEX = /(?:^|[\s(])((?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9_-]{1,10})(?:$|[\s),.:;])/gmu;

/** Config files whose changes often affect the entire repository context. */
const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.js",
  "vitest.config.ts",
]);

/**
 * Extracts candidate file paths mentioned in advice text and action item summaries.
 */
export function extractMentionedFiles(
  adviceText: string,
  actionItemSummaries: readonly string[] = [],
): readonly string[] {
  const combined = `${adviceText}\n${actionItemSummaries.join("\n")}`;
  const found = new Set<string>();

  // 1. Extract from backticks
  let match: RegExpExecArray | null;
  while ((match = BACKTICK_FILE_REGEX.exec(combined)) !== null) {
    const candidate = cleanPath(match[1]);
    if (candidate) found.add(candidate);
  }

  // 2. Extract from general paths
  while ((match = GENERAL_PATH_REGEX.exec(combined)) !== null) {
    const candidate = cleanPath(match[1]);
    if (candidate) found.add(candidate);
  }

  return Array.from(found).sort();
}

function cleanPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let p = raw.trim();

  // Strip leading ./
  if (p.startsWith("./")) {
    p = p.slice(2);
  }

  // Ignore URLs or remote references
  if (p.startsWith("http://") || p.startsWith("https://") || p.includes("github.com/")) {
    return undefined;
  }

  // Basic path hygiene
  if (p.includes("..") || p.includes(":") || p.length < 3) {
    return undefined;
  }

  return p;
}

/**
 * Computes relevant file changes between checkpoint and current HEAD.
 */
export async function analyzeFileDrift(options: {
  readonly git: GitExecutor;
  readonly cwd: string;
  readonly checkpoint: FullCommitSha;
  readonly currentHead: FullCommitSha;
  readonly mentionedFiles: readonly string[];
}): Promise<RelevantFileDrift> {
  const { git, cwd, checkpoint, currentHead, mentionedFiles } = options;

  if (checkpoint === currentHead) {
    return {
      changedFiles: [],
      mentionedFiles,
      directlyAffectedFiles: [],
      relatedContextFiles: [],
    };
  }

  // Execute read-only git diff --name-status
  const diffResult = await git.runAllowingFailure(
    ["diff", "--name-status", checkpoint, currentHead],
    cwd,
  );

  const changedFiles = parseDiffNameStatus(diffResult.code === 0 ? diffResult.stdout : "");
  const changedPathsSet = new Set(changedFiles.map((c) => c.path));

  // Directly affected: mentioned in advice AND changed in git diff
  const directlyAffectedFiles = mentionedFiles.filter((path) => changedPathsSet.has(path));
  const directlyAffectedSet = new Set(directlyAffectedFiles);

  // Directories of directly affected files
  const affectedDirs = new Set(
    directlyAffectedFiles.map((path) => {
      const slash = path.lastIndexOf("/");
      return slash !== -1 ? path.slice(0, slash) : "";
    }),
  );

  // Related context: configs, test files of affected files, or files in the same directory
  const relatedContextFiles: string[] = [];

  for (const change of changedFiles) {
    if (directlyAffectedSet.has(change.path)) continue;

    const fileName = change.path.split("/").pop() ?? change.path;
    const slash = change.path.lastIndexOf("/");
    const dir = slash !== -1 ? change.path.slice(0, slash) : "";

    if (CONFIG_FILE_NAMES.has(fileName)) {
      relatedContextFiles.push(change.path);
      continue;
    }

    // Associated test file (e.g. affected is foo.ts, changed is foo.test.ts)
    const isTestOfAffected = directlyAffectedFiles.some((aff) => {
      const baseName = aff.replace(/\.[a-zA-Z0-9]+$/, "");
      return change.path.startsWith(baseName) && (change.path.includes(".test.") || change.path.includes(".spec."));
    });

    if (isTestOfAffected) {
      relatedContextFiles.push(change.path);
      continue;
    }

    // Same directory
    if (affectedDirs.has(dir) && dir.length > 0) {
      relatedContextFiles.push(change.path);
      continue;
    }
  }

  return {
    changedFiles,
    mentionedFiles,
    directlyAffectedFiles: directlyAffectedFiles.sort(),
    relatedContextFiles: relatedContextFiles.sort(),
  };
}

/**
 * Parses git diff --name-status output into structured FileChange records.
 */
export function parseDiffNameStatus(output: string): readonly FileChange[] {
  const lines = output.split("\n");
  const results: FileChange[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const parts = line.split("\t");
    const statusCode = parts[0]?.trim();
    if (!statusCode) continue;

    const codeChar = statusCode[0];

    if (codeChar === "R") {
      // Rename: R100\toldPath\tnewPath
      const oldPath = parts[1]?.trim();
      const newPath = parts[2]?.trim();
      if (newPath) {
        results.push({ path: newPath, status: "renamed", oldPath });
      }
    } else {
      const path = parts[1]?.trim();
      if (!path) continue;

      let status: FileChangeStatus = "modified";
      if (codeChar === "A") status = "added";
      else if (codeChar === "D") status = "deleted";
      else if (codeChar === "M") status = "modified";

      results.push({ path, status });
    }
  }

  return results;
}
