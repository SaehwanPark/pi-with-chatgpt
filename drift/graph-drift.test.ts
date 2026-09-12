import { describe, expect, it } from "vitest";

import { CHECKPOINT_SHA, OTHER_CHECKPOINT_SHA, fakeGit } from "../test/fixtures.js";
import { analyzeGraphDrift } from "./graph-drift.js";
import { requireFullCommitSha } from "../protocol/sha.js";

const CHECKPOINT = CHECKPOINT_SHA;
const HEAD = OTHER_CHECKPOINT_SHA;
const THIRD_SHA = requireFullCommitSha("c".repeat(40));

describe("analyzeGraphDrift (M7)", () => {
  it("returns equal for identical commit SHAs without invoking git", async () => {
    const { executor: git } = fakeGit({});
    const result = await analyzeGraphDrift({
      git,
      cwd: "/repo",
      checkpoint: CHECKPOINT,
      currentHead: CHECKPOINT,
    });

    expect(result.verdict).toBe("equal");
    expect(result.commitsAhead).toBe(0);
    expect(result.commitsBehind).toBe(0);
  });

  it("detects checkpoint is ancestor of HEAD with commits ahead", async () => {
    const { executor: git } = fakeGit({
      [`merge-base --is-ancestor ${CHECKPOINT} ${HEAD}`]: { code: 0 },
      [`merge-base --is-ancestor ${HEAD} ${CHECKPOINT}`]: { code: 1 },
      [`merge-base ${CHECKPOINT} ${HEAD}`]: { code: 0, stdout: CHECKPOINT },
      [`rev-list --count --left-right ${CHECKPOINT}...${HEAD}`]: { code: 0, stdout: "0\t3\n" },
    });

    const result = await analyzeGraphDrift({
      git,
      cwd: "/repo",
      checkpoint: CHECKPOINT,
      currentHead: HEAD,
    });

    expect(result.verdict).toBe("checkpoint-is-ancestor");
    expect(result.commitsAhead).toBe(3);
    expect(result.commitsBehind).toBe(0);
  });

  it("detects checkpoint is descendant of HEAD with commits behind", async () => {
    const { executor: git } = fakeGit({
      [`merge-base --is-ancestor ${CHECKPOINT} ${HEAD}`]: { code: 1 },
      [`merge-base --is-ancestor ${HEAD} ${CHECKPOINT}`]: { code: 0 },
      [`merge-base ${CHECKPOINT} ${HEAD}`]: { code: 0, stdout: HEAD },
      [`rev-list --count --left-right ${CHECKPOINT}...${HEAD}`]: { code: 0, stdout: "2\t0\n" },
    });

    const result = await analyzeGraphDrift({
      git,
      cwd: "/repo",
      checkpoint: CHECKPOINT,
      currentHead: HEAD,
    });

    expect(result.verdict).toBe("checkpoint-is-descendant");
    expect(result.commitsAhead).toBe(0);
    expect(result.commitsBehind).toBe(2);
  });

  it("detects diverged histories with ahead and behind counts", async () => {
    const { executor: git } = fakeGit({
      [`merge-base --is-ancestor ${CHECKPOINT} ${HEAD}`]: { code: 1 },
      [`merge-base --is-ancestor ${HEAD} ${CHECKPOINT}`]: { code: 1 },
      [`merge-base ${CHECKPOINT} ${HEAD}`]: { code: 0, stdout: THIRD_SHA },
      [`rev-list --count --left-right ${CHECKPOINT}...${HEAD}`]: { code: 0, stdout: "4\t2\n" },
    });

    const result = await analyzeGraphDrift({
      git,
      cwd: "/repo",
      checkpoint: CHECKPOINT,
      currentHead: HEAD,
    });

    expect(result.verdict).toBe("diverged");
    expect(result.commitsAhead).toBe(2);
    expect(result.commitsBehind).toBe(4);
  });

  it("detects unreachable / missing objects", async () => {
    const { executor: git } = fakeGit({
      [`merge-base --is-ancestor ${CHECKPOINT} ${HEAD}`]: { code: 128 },
      [`merge-base --is-ancestor ${HEAD} ${CHECKPOINT}`]: { code: 128 },
      [`merge-base ${CHECKPOINT} ${HEAD}`]: { code: 128 },
    });

    const result = await analyzeGraphDrift({
      git,
      cwd: "/repo",
      checkpoint: CHECKPOINT,
      currentHead: HEAD,
    });

    expect(result.verdict).toBe("unreachable");
    expect(result.commitsAhead).toBe(0);
    expect(result.commitsBehind).toBe(0);
  });
});
