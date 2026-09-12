import { describe, expect, it } from "vitest";

import { CHECKPOINT_SHA, OTHER_CHECKPOINT_SHA, fakeGit } from "../test/fixtures.js";
import {
  extractMentionedFiles,
  parseDiffNameStatus,
  analyzeFileDrift,
} from "./file-drift.js";

const CHECKPOINT = CHECKPOINT_SHA;
const HEAD = OTHER_CHECKPOINT_SHA;

describe("file-drift (M7)", () => {
  describe("extractMentionedFiles", () => {
    it("extracts paths from backticks and text", () => {
      const advice = `
Review the implementation in \`src/runtime/ownership.ts\`.
Also check tests in \`tests/ownership.test.ts\` and \`package.json\`.
We should avoid touching https://github.com/foo/bar.
And look at src/core/engine.ts as well.
`;
      const actionItems = ["Refactor `src/runtime/helper.ts` to handle errors."];

      const files = extractMentionedFiles(advice, actionItems);

      expect(files).toContain("src/runtime/ownership.ts");
      expect(files).toContain("tests/ownership.test.ts");
      expect(files).toContain("package.json");
      expect(files).toContain("src/core/engine.ts");
      expect(files).toContain("src/runtime/helper.ts");
      expect(files.some((f) => f.includes("http"))).toBe(false);
    });

    it("normalizes leading ./", () => {
      const files = extractMentionedFiles("See `./config/schema.ts` for details.");
      expect(files).toEqual(["config/schema.ts"]);
    });
  });

  describe("parseDiffNameStatus", () => {
    it("parses modified, added, deleted, and renamed files", () => {
      const output = `
M\tsrc/runtime/ownership.ts
A\tsrc/runtime/new-file.ts
D\tsrc/legacy.ts
R100\tsrc/old.ts\tsrc/renamed.ts
`.trim();

      const changes = parseDiffNameStatus(output);
      expect(changes).toEqual([
        { path: "src/runtime/ownership.ts", status: "modified" },
        { path: "src/runtime/new-file.ts", status: "added" },
        { path: "src/legacy.ts", status: "deleted" },
        { path: "src/renamed.ts", status: "renamed", oldPath: "src/old.ts" },
      ]);
    });
  });

  describe("analyzeFileDrift", () => {
    it("returns empty drift when checkpoint equals HEAD", async () => {
      const { executor: git } = fakeGit({});
      const drift = await analyzeFileDrift({
        git,
        cwd: "/repo",
        checkpoint: CHECKPOINT,
        currentHead: CHECKPOINT,
        mentionedFiles: ["src/runtime.ts"],
      });

      expect(drift.changedFiles).toEqual([]);
      expect(drift.directlyAffectedFiles).toEqual([]);
      expect(drift.relatedContextFiles).toEqual([]);
    });

    it("detects directly affected files and related context changes", async () => {
      const diffOutput = `
M\tsrc/runtime/ownership.ts
M\tsrc/runtime/ownership.test.ts
M\tsrc/runtime/other-sibling.ts
M\tpackage.json
M\tunrelated/worker.ts
`.trim();

      const { executor: git } = fakeGit({
        [`diff --name-status ${CHECKPOINT} ${HEAD}`]: { code: 0, stdout: diffOutput },
      });

      const drift = await analyzeFileDrift({
        git,
        cwd: "/repo",
        checkpoint: CHECKPOINT,
        currentHead: HEAD,
        mentionedFiles: ["src/runtime/ownership.ts"],
      });

      expect(drift.directlyAffectedFiles).toEqual(["src/runtime/ownership.ts"]);
      expect(drift.relatedContextFiles).toContain("src/runtime/ownership.test.ts");
      expect(drift.relatedContextFiles).toContain("package.json");
      expect(drift.relatedContextFiles).toContain("src/runtime/other-sibling.ts");
      expect(drift.relatedContextFiles).not.toContain("unrelated/worker.ts");
    });
  });
});
