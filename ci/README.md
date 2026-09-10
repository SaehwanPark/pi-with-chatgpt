# ci/

`ci.yml` is the authoritative CI definition: `verify` (typecheck, lint, build, unit tests) plus the
Pi installation/load smoke test on `ubuntu-latest` and `macos-latest`.

**Why it is not in `.github/workflows/` yet:** GitHub refuses any push that adds or changes a file
under `.github/workflows/` unless the pushing credential also has the `workflow` OAuth scope. The
automation token available for this repository has `repo, gist, read:org, admin:public_key` and SSH
access to `github.com:22` is blocked on this network, so the workflow cannot be committed by the
agent. The maintainer action is one of:

1. grant the scope — `gh auth refresh -h github.com -s workflow` — after which
   `git mv ci/ci.yml .github/workflows/ci.yml && git commit` is the only change needed; or
2. add the file directly (the repository's Actions settings can also enable "workflow files from
   collaborators", which is broader than needed here).

Nothing else in the repository reads this directory; the file is plain YAML and is not executed
locally.
