# Changelog

All notable changes to `pi-with-chatgpt` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is updated in the same commit as the change it describes, together with any docs that
change invalidates (see `AGENTS.md`).

## [Unreleased]

### Added — M0 (repository and architecture foundation)

- Toolchain and package: `package.json` for `pi-with-chatgpt` (ESM, `engines.node >= 22.19.0`,
  Pi package manifest with `pi.extensions = ./dist/extension/index.js` and the `pi-package`
  keyword), `tsconfig.json`/`tsconfig.json`, ESLint flat config, Vitest config, MIT `LICENSE`,
  and CI (`.github/workflows/ci.yml`) on `ubuntu-latest` + `macos-latest`.
- The eleven planned module trees — `extension/ git/ auth/ browser/ chatgpt/ jobs/ protocol/
  ledger/ drift/ config/ ui/` — each with a documented barrel.
- Architecture invariants INV-01…INV-16 written down in `docs/ARCHITECTURE.md` and indexed as data
  in `protocol/invariants.ts`; enforced by typed boundaries and guards in `protocol/`, `git/`,
  `auth/`, `browser/`, `chatgpt/`, `jobs/`, `ledger/`, `config/`, and `ui/`.
- Zero-side-effect Pi activation (`extension/index.ts`) with a smoke test that installs the package
  into an isolated Pi root and asserts that nothing is registered (`test/pi-smoke.mjs`).
- Security contract `docs/SECURITY.md` (trust boundaries, credential containment, prompt-injection
  posture) and module-boundary tests (`test/module-boundaries.test.ts`).
- 154 unit tests across 18 files.

### Changed

- Toolchain fixed to TypeScript + Node 22 + npm + vitest (previously "to be fixed in M0");
  `README.md` development commands updated from the provisional `bun` examples.
- Roadmap M0 checkboxes ticked with a named artifact/test per item.

### Not yet implemented

No adviser behaviour yet: checkpoint resolution (M1), authentication (M2), browser automation
(M3–M4), consultation protocol (M5–M7), commands/UI (M8), and hardening/release (M9–M10). Until
then the extension registers no commands and no tools, by design.
