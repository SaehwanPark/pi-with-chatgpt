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
  keyword), `tsconfig.json`/`tsconfig.build.json`, ESLint flat config, Vitest config, MIT `LICENSE`,
  and CI (`ci/ci.yml`, staged outside `.github/workflows/` until a credential with the `workflow`
  scope is available — see `ci/README.md`) on `ubuntu-latest` + `macos-latest`.
- The eleven planned module trees — `extension/ git/ auth/ browser/ chatgpt/ jobs/ protocol/
  ledger/ drift/ config/ ui/` — each with a documented barrel.
- Architecture invariants INV-01…INV-16 written down in `docs/ARCHITECTURE.md` and indexed as data
  in `protocol/invariants.ts`; enforced by typed boundaries and guards in `protocol/`, `git/`,
  `auth/`, `browser/`, `chatgpt/`, `jobs/`, `ledger/`, `config/`, and `ui/`.
- Zero-side-effect Pi activation (`extension/index.ts`) with a smoke test that installs the package
  into an isolated Pi root and asserts that nothing is registered (`test/pi-smoke.mjs`).
- Security contract `docs/SECURITY.md` (trust boundaries, credential containment, prompt-injection
  posture) and module-boundary tests (`test/module-boundaries.test.ts`).
- 160 unit tests across 18 files.

### Hardened after invariant review (M0)

- `assertPersistenceOrder` fails closed when a persistence step is missing instead of treating an
  omission as "nothing to check" (INV-15).
- `git/authority.ts` now refuses arguments that write files or execute programs on otherwise read-only
  subcommands (`--output`, `--ext-diff`, `--textconv`, `--paginate`, `--upload-pack`,
  `--receive-pack`, `--exec-path`, `--git-dir`, `--work-tree`, `-c`, `-C`, …) (INV-06).
- `parseGitHubRemote` refuses credential-bearing remote URLs with `credentials-in-url` instead of
  silently canonicalising them (INV-12); conversation keys percent-encode the task id so a task id
  containing `:` cannot imitate another conversation (INV-09).
- Project-scope configuration cannot set `dependencyDefault: "required"`: blocking on adviser
  availability stays a user-level decision (INV-07).
- `draft`/`queued` may transition to `failed` (preflight and dispatch preconditions fail before the
  job ever runs); ledger scanning also rejects PEM private-key blocks.
- Docs corrected: `docs/SECURITY.md` invariant table now cites real symbols and the correct invariant
  ids, `docs/ARCHITECTURE.md` invariant headings are addressable anchors, and `AGENTS.md` records the
  fixed toolchain instead of the pre-M0 "specification-only / bun vs npm" wording.

### Changed

- Toolchain fixed to TypeScript + Node 22 + npm + vitest (previously "to be fixed in M0");
  `README.md` development commands updated from the provisional `bun` examples.
- Roadmap M0 checkboxes ticked with a named artifact/test per item.

### Not yet implemented

No adviser behaviour yet: checkpoint resolution (M1), authentication (M2), browser automation
(M3–M4), consultation protocol (M5–M7), commands/UI (M8), and hardening/release (M9–M10). Until
then the extension registers no commands and no tools, by design.
