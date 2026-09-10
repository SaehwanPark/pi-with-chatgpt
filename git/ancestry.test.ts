import { describe, expect, it } from "vitest";

import { CHECKPOINT_SHA, OTHER_CHECKPOINT_SHA, fakeGit, type FakeGitOutcome } from "../test/fixtures.js";
import {
  aheadBehind,
  classifyRelation,
  compareCommits,
  interpretIsAncestorExitCode,
  parseAheadBehindCounts,
} from "./ancestry.js";

const LEFT = CHECKPOINT_SHA;
const RIGHT = OTHER_CHECKPOINT_SHA;

type MergeBaseOutcomes = {
  readonly leftToRight?: FakeGitOutcome | string;
  readonly rightToLeft?: FakeGitOutcome | string;
  readonly mergeBase?: FakeGitOutcome | string;
};

function ancestryGit(outcomes: MergeBaseOutcomes) {
  return fakeGit({
    [`merge-base --is-ancestor ${LEFT} ${RIGHT}`]: outcomes.leftToRight ?? { code: 1 },
    [`merge-base --is-ancestor ${RIGHT} ${LEFT}`]: outcomes.rightToLeft ?? { code: 1 },
    [`merge-base ${LEFT} ${RIGHT}`]: outcomes.mergeBase ?? { code: 1, stdout: "" },
  });
}

describe("interpretIsAncestorExitCode", () => {
  it("maps 0 to true and 1 to false", () => {
    expect(interpretIsAncestorExitCode(0)).toBe(true);
    expect(interpretIsAncestorExitCode(1)).toBe(false);
  });

  it("maps 128 (missing object or shallow boundary) to unknown, not false", () => {
    // Reporting unknown as false is what would let a consultation be described as "not pushed"
    // when the real cause was a shallow clone.
    expect(interpretIsAncestorExitCode(128)).toBeUndefined();
    expect(interpretIsAncestorExitCode(1)).not.toBe(interpretIsAncestorExitCode(128));
  });
});

describe("classifyRelation", () => {
  it("short-circuits identical SHAs to equal", () => {
    expect(
      classifyRelation({
        identical: true,
        leftIsAncestorOfRight: undefined,
        rightIsAncestorOfLeft: undefined,
        hasMergeBase: false,
      }),
    ).toBe("equal");
  });

  it("returns undefined when either direction is unanswered", () => {
    expect(
      classifyRelation({
        identical: false,
        leftIsAncestorOfRight: undefined,
        rightIsAncestorOfLeft: true,
        hasMergeBase: true,
      }),
    ).toBeUndefined();
  });

  it("classifies ahead, behind, diverged, and unrelated", () => {
    const base = { identical: false, hasMergeBase: true };
    expect(
      classifyRelation({ ...base, leftIsAncestorOfRight: true, rightIsAncestorOfLeft: false }),
    ).toBe("left-ancestor-of-right");
    expect(
      classifyRelation({ ...base, leftIsAncestorOfRight: false, rightIsAncestorOfLeft: true }),
    ).toBe("right-ancestor-of-left");
    expect(
      classifyRelation({ ...base, leftIsAncestorOfRight: false, rightIsAncestorOfLeft: false }),
    ).toBe("diverged");
    expect(
      classifyRelation({
        identical: false,
        hasMergeBase: false,
        leftIsAncestorOfRight: false,
        rightIsAncestorOfLeft: false,
      }),
    ).toBe("unrelated");
  });
});

describe("compareCommits", () => {
  it("reports the left side behind when only left-to-right is an ancestor", async () => {
    const { executor, invocations } = ancestryGit({
      leftToRight: { code: 0 },
      rightToLeft: { code: 1 },
      mergeBase: { code: 0, stdout: `${LEFT}\n` },
    });

    await expect(compareCommits(executor, "/repo", LEFT, RIGHT)).resolves.toBe(
      "left-ancestor-of-right",
    );
    expect(invocations).toEqual([
      ["merge-base", "--is-ancestor", LEFT, RIGHT],
      ["merge-base", "--is-ancestor", RIGHT, LEFT],
      ["merge-base", LEFT, RIGHT],
    ]);
  });

  it("reports equal for the same SHA without needing git's answer", async () => {
    const { executor } = ancestryGit({ leftToRight: { code: 0 }, rightToLeft: { code: 0 } });
    await expect(compareCommits(executor, "/repo", LEFT, LEFT)).resolves.toBe("equal");
  });

  it("reports diverged when neither side contains the other", async () => {
    const { executor } = ancestryGit({
      leftToRight: { code: 1 },
      rightToLeft: { code: 1 },
      mergeBase: { code: 0, stdout: `${RIGHT}\n` },
    });
    await expect(compareCommits(executor, "/repo", LEFT, RIGHT)).resolves.toBe("diverged");
  });

  it("reports unrelated histories when there is no merge base", async () => {
    const { executor } = ancestryGit({
      leftToRight: { code: 1 },
      rightToLeft: { code: 1 },
      mergeBase: { code: 1, stdout: "" },
    });
    await expect(compareCommits(executor, "/repo", LEFT, RIGHT)).resolves.toBe("unrelated");
  });

  it("reports unknown when a commit object is missing", async () => {
    const { executor } = ancestryGit({
      leftToRight: { code: 128, stderr: "fatal: Not a valid object name" },
      rightToLeft: { code: 128, stderr: "fatal: Not a valid object name" },
      mergeBase: { code: 128, stdout: "" },
    });
    await expect(compareCommits(executor, "/repo", LEFT, RIGHT)).resolves.toBeUndefined();
  });
});

describe("parseAheadBehindCounts", () => {
  it("maps `<behind>\\t<ahead>` to the right fields", () => {
    // Direction is inverted by an easy mistake, and an inverted count tells the user to push when
    // the branch actually diverged.
    expect(parseAheadBehindCounts("2\t5")).toEqual({ ahead: 5, behind: 2 });
    expect(parseAheadBehindCounts("0\t0")).toEqual({ ahead: 0, behind: 0 });
  });

  it("returns undefined for unexpected output", () => {
    expect(parseAheadBehindCounts("fatal: bad revision")).toBeUndefined();
  });
});

describe("aheadBehind", () => {
  function countsGit(outcome: FakeGitOutcome | string) {
    return fakeGit({ [`rev-list --count --left-right ${LEFT}...${RIGHT}`]: outcome });
  }

  it("counts ahead and behind commits", async () => {
    const { executor } = countsGit("3\t1");
    await expect(aheadBehind(executor, "/repo", LEFT, RIGHT)).resolves.toEqual({
      ahead: 1,
      behind: 3,
    });
  });

  it("returns undefined when git cannot answer", async () => {
    const { executor } = countsGit({ code: 128, stdout: "" });
    await expect(aheadBehind(executor, "/repo", LEFT, RIGHT)).resolves.toBeUndefined();
  });
});
