import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INVARIANT_IDS, INVARIANTS, plannedGuards } from "./invariants.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("invariant index", () => {
  it("documents all sixteen invariants exactly once", () => {
    expect(INVARIANT_IDS).toHaveLength(16);
    expect(new Set(INVARIANT_IDS).size).toBe(16);
    expect(INVARIANTS.map((invariant) => invariant.id)).toEqual([...INVARIANT_IDS]);
  });

  it("gives every invariant a prose source and a guard location", () => {
    for (const invariant of INVARIANTS) {
      expect(invariant.summary.length, invariant.id).toBeGreaterThan(20);
      expect(invariant.source, invariant.id).toContain("docs/ARCHITECTURE.md");
      expect(invariant.guard, invariant.id).toMatch(/^(planned:M\d+|[\w./-]+\.ts)/u);
    }
  });

  it("points every implemented guard at a file that exists", () => {
    for (const invariant of INVARIANTS) {
      if (invariant.guard.startsWith("planned:")) continue;
      for (const file of invariant.guard.split(" + ")) {
        expect(existsSync(`${repoRoot}${file}`), `${invariant.id} guard ${file}`).toBe(true);
      }
    }
  });

  it("keeps deferred guards to the one that needs unwritten machinery", () => {
    // INV-14 needs the M6 prompt assembler. A deferred guard must be re-checked at every milestone:
    // an invariant left "planned" forever is how a safety property quietly disappears.
    expect(plannedGuards().map((invariant) => invariant.id)).toEqual(["INV-14"]);
  });

  it("documents the invariant set in the architecture doc", () => {
    const doc = readFileSync(`${repoRoot}docs/ARCHITECTURE.md`, "utf8");
    for (const id of INVARIANT_IDS) {
      expect(doc, `docs/ARCHITECTURE.md missing ${id}`).toContain(id);
    }
  });
});
