# CI

The active GitHub Actions workflow is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
It runs typecheck, lint, build, unit tests, and the Pi installation/load smoke test on
`ubuntu-latest` and `macos-latest` for pushes to `main`, pull requests, and manual dispatches.

This directory is retained for CI documentation only; keep the workflow under
`.github/workflows/` so GitHub executes it and branch protection can require its checks.
