#!/usr/bin/env node
/**
 * Pi-load smoke test (M0 exit criterion: "package installs into Pi", "extension loads without side
 * effects").
 *
 * Three checks, in increasing strength:
 *
 * 1. the built extension entry is loadable ESM and activates against a mock Pi API without
 *    registering or touching anything;
 * 2. `pi install <this package>` succeeds against a throwaway `PI_CODING_AGENT_DIR`, proving the
 *    package metadata (`pi.extensions`) is valid;
 * 3. `pi list` reports the installed package.
 *
 * Nothing here calls a model, opens a browser, or touches the developer's real Pi configuration.
 * When the `pi` binary is unavailable the script reports SKIP for checks 2–3 and exits 0, so a
 * partial environment fails loudly on the build contract but not on a missing optional tool.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(packageRoot, "dist", "extension", "index.js");

function check(name, condition, detail = "") {
  if (!condition) fail(name, detail || "assertion failed");
  console.log(`  ok  ${name}`);
}

function fail(name, detail) {
  console.error(`  FAIL ${name}: ${detail}`);
  process.exit(1);
}

function command(name, args, env) {
  return execFileSync(name, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

console.log("pi-with-chatgpt Pi-load smoke test");

if (!existsSync(entry)) fail("built entry", `run "npm run build" first (expected ${entry})`);

// 1. The built artifact, not the TypeScript source: this is what Pi actually imports.
const module = await import(entry);
check("default export is an activation function", typeof module.default === "function");

let commandCount = 0;
let toolCount = 0;
const mockPi = {
  registerCommand() {
    commandCount += 1;
  },
  registerTool() {
    toolCount += 1;
  },
  on() {},
};

const activation = module.default(mockPi);
check("activation registers 11 slash commands", commandCount === 11, `registered ${commandCount} commands`);
check("activation registers 8 agent tools", toolCount === 8, `registered ${toolCount} tools`);
check("activation returns its configuration", activation?.config?.dependencyDefault === "advisory");

// 2 + 3. Real Pi installation, isolated from the developer's configuration.
let piVersion = null;
try {
  piVersion = command("pi", ["--version"], {}).trim();
} catch {
  console.log('  SKIP pi install checks ("pi" binary not on PATH)');
}

if (piVersion !== null) {
  check("pi meets the declared version floor", piVersionAtLeast(piVersion, module.MIN_PI_VERSION), `pi ${piVersion} < ${module.MIN_PI_VERSION}`);

  const agentDir = mkdtempSync(join(tmpdir(), "pi-with-chatgpt-smoke-"));
  try {
    const env = { PI_CODING_AGENT_DIR: join(agentDir, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
    command("pi", ["install", packageRoot], env);
    const listed = command("pi", ["list"], env);
    check("pi install registers the package", listed.includes("pi-with-chatgpt"), listed.trim());
  } catch (error) {
    fail("pi install", error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
  console.log(`  pi: ${piVersion}`);
}

console.log("PASS");

function piVersionAtLeast(actual, minimum) {
  const parse = (value) => value.replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [aMajor, aMinor, aPatch] = parse(actual);
  const [mMajor, mMinor, mPatch] = parse(minimum);
  return aMajor !== mMajor
    ? aMajor > mMajor
    : aMinor !== mMinor
      ? aMinor > mMinor
      : aPatch >= mPatch;
}
