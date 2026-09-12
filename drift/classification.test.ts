import { describe, expect, it } from "vitest";

import { classifyAdviceStatus } from "./classification.js";
import { CHECKPOINT_SHA, OTHER_CHECKPOINT_SHA } from "../test/fixtures.js";
import type { GraphDriftResult } from "./graph-drift.js";
import type { RelevantFileDrift } from "./file-drift.js";

const CHECKPOINT = CHECKPOINT_SHA;
const HEAD = OTHER_CHECKPOINT_SHA;

describe("classifyAdviceStatus (M7)", () => {
  it("classifies identical commits as current", () => {
    const graph: GraphDriftResult = {
      checkpoint: CHECKPOINT,
      currentHead: CHECKPOINT,
      verdict: "equal",
      commitsAhead: 0,
      commitsBehind: 0,
    };

    const report = classifyAdviceStatus(graph);
    expect(report.classification).toBe("current");
    expect(report.summaryNote).toContain("matches current HEAD");
    expect(report.affectedActionItemIds).toEqual([]);
  });

  it("classifies ancestor with no directly affected files as likely_applicable", () => {
    const graph: GraphDriftResult = {
      checkpoint: CHECKPOINT,
      currentHead: HEAD,
      verdict: "checkpoint-is-ancestor",
      commitsAhead: 3,
      commitsBehind: 0,
    };

    const fileDrift: RelevantFileDrift = {
      changedFiles: [{ path: "docs/README.md", status: "modified" }],
      mentionedFiles: ["src/runtime.ts"],
      directlyAffectedFiles: [],
      relatedContextFiles: [],
    };

    const report = classifyAdviceStatus(graph, fileDrift);
    expect(report.classification).toBe("likely_applicable");
    expect(report.summaryNote).toContain("3 commits ahead");
    expect(report.affectedActionItemIds).toEqual([]);
  });

  it("classifies ancestor with directly affected files as materially_stale and flags action items", () => {
    const graph: GraphDriftResult = {
      checkpoint: CHECKPOINT,
      currentHead: HEAD,
      verdict: "checkpoint-is-ancestor",
      commitsAhead: 3,
      commitsBehind: 0,
    };

    const fileDrift: RelevantFileDrift = {
      changedFiles: [{ path: "src/runtime/ownership.ts", status: "modified" }],
      mentionedFiles: ["src/runtime/ownership.ts"],
      directlyAffectedFiles: ["src/runtime/ownership.ts"],
      relatedContextFiles: ["tests/ownership.test.ts"],
    };

    const actionItems = [
      { id: "A1", summary: "Keep standard configuration" },
      { id: "A2", summary: "Refactor src/runtime/ownership.ts to use weak maps" },
    ];

    const report = classifyAdviceStatus(graph, fileDrift, actionItems);
    expect(report.classification).toBe("materially_stale");
    expect(report.affectedActionItemIds).toEqual(["A2"]);
    expect(report.summaryNote).toContain("Relevant drift: src/runtime/ownership.ts");
    expect(report.summaryNote).toContain("Recommendations A2 may need revalidation.");
  });

  it("classifies diverged branches as needs_reconsultation", () => {
    const graph: GraphDriftResult = {
      checkpoint: CHECKPOINT,
      currentHead: HEAD,
      verdict: "diverged",
      commitsAhead: 2,
      commitsBehind: 4,
    };

    const report = classifyAdviceStatus(graph);
    expect(report.classification).toBe("needs_reconsultation");
    expect(report.summaryNote).toContain("Histories diverged");
  });

  it("classifies unreachable checkpoints as provenance_degraded", () => {
    const graph: GraphDriftResult = {
      checkpoint: CHECKPOINT,
      currentHead: HEAD,
      verdict: "unreachable",
      commitsAhead: 0,
      commitsBehind: 0,
    };

    const report = classifyAdviceStatus(graph);
    expect(report.classification).toBe("provenance_degraded");
    expect(report.summaryNote).toContain("unreachable");
  });
});
