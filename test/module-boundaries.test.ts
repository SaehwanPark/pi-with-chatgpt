import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** The module boundaries fixed by the roadmap; nothing else may grow at the repository root. */
const MODULES = [
  "extension",
  "git",
  "auth",
  "browser",
  "chatgpt",
  "jobs",
  "protocol",
  "ledger",
  "drift",
  "config",
  "ui",
];

const ALLOWED_ROOT_ENTRIES = [
  ".agents",
  ".github",
  ".gitignore",
  ".pi",
  "AGENTS.md",
  "auth",
  "browser",
  "CHANGELOG.md",
  "ci",
  "chatgpt",
  "config",
  "docs",
  "drift",
  "eslint.config.js",
  "extension",
  "git",
  "jobs",
  "LICENSE",
  "ledger",
  "package-lock.json",
  "package.json",
  "protocol",
  "README.md",
  "test",
  "tsconfig.build.json",
  "tsconfig.json",
  "ui",
  "vitest.config.ts",
];

describe("module boundaries (M0)", () => {
  it.each(MODULES)("has a %s module with a barrel and a documented purpose", (module) => {
    const barrel = join(repoRoot, module, "index.ts");
    expect(existsSync(barrel), `${module}/index.ts missing`).toBe(true);
    const source = readFileSync(barrel, "utf8");
    expect(source.startsWith("/**"), `${module}/index.ts undocumented`).toBe(true);
    expect(source).toContain(`\`${module}/\``);
  });

  it("creates no sibling source trees next to the planned modules", () => {
    const unexpected = readdirSync(repoRoot)
      .filter((entry) => !entry.startsWith("."))
      .filter((entry) => !ALLOWED_ROOT_ENTRIES.includes(entry))
      .filter((entry) => !["dist", "node_modules", "_workspace", "coverage"].includes(entry));
    expect(unexpected).toEqual([]);
  });

  it("keeps protocol/ free of dependencies on the modules that consume it", () => {
    // Vocabulary modules that import behaviour would make the invariants untestable in isolation.
    const offenders = tsFiles(join(repoRoot, "protocol"))
      .filter((file) => /from "\.\.\//u.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(repoRoot, ""));
    expect(offenders).toEqual([]);
  });

  it("keeps the package manifest pointed at the built extension entry", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      pi: { extensions: string[] };
      keywords: string[];
    };
    expect(manifest.pi.extensions).toEqual(["./dist/extension/index.js"]);
    expect(manifest.keywords).toContain("pi-package");
  });
});

function tsFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [full] : [];
  });
}
